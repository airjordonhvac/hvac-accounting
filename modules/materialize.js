// =============================================================================
// Materialization
// -----------------------------------------------------------------------------
// Turns an approved `pending_entries` row into a real record in the right
// table. Now supports:
//   bill          → bills + bill_lines
//   invoice       → invoices + invoice_lines (NEW — for customer-facing AR)
//   project       → projects (auto-create customer)
//   bank_transactions → import_batches + bank_transactions
//   vendor_update → vendors (W-9)
// =============================================================================
import { supabase, q } from '../lib/supabase.js';
import { getCurrentUser } from '../lib/auth.js';

const COA_BY_CATEGORY = {
  material: '5200',
  labor: '5000',
  equipment: '5400',
  subcontract: '5300',
  other: '6999',
};

export async function materialize(entry, doc) {
  try {
    let result;
    if (entry.entry_type === 'bill')              result = await materializeBill(entry, doc);
    else if (entry.entry_type === 'invoice')      result = await materializeInvoice(entry, doc);
    else if (entry.entry_type === 'project')      result = await materializeProject(entry, doc);
    else if (entry.entry_type === 'bank_transactions') result = await materializeBankStatement(entry, doc);
    else if (entry.entry_type === 'vendor_update')     result = await materializeW9(entry, doc);
    else throw new Error(`Unknown entry_type: ${entry.entry_type}`);

    await q(supabase.from('pending_entries').update({
      status: 'approved',
      created_record_table: result.table,
      created_record_id: result.id,
    }).eq('id', entry.id));

    return { ok: true, ...result };
  } catch (e) {
    console.error('[materialize] failed:', e);
    return { ok: false, error: e.message || String(e) };
  }
}

// =============================================================================
// INVOICE — customer-facing invoice you SENT → public.invoices + invoice_lines
// =============================================================================
async function materializeInvoice(entry, doc) {
  const raw = entry.raw_extraction || {};
  const user = getCurrentUser();

  // 1. Resolve customer. Prefer user-edited override, then matched, then extraction.
  // The extractor often misidentifies your own letterhead as "vendor_name", so we
  // accept a customer name from edited_customer_name (user override) OR
  // raw.customer_name OR raw.bill_to_name as fallbacks.
  const customerName = raw.edited_customer_name || raw.customer_name || raw.bill_to_name;
  if (!customerName) throw new Error('No customer name. Edit the entry to add the customer.');
  const customerId = entry.matched_customer_id || await ensureCustomer(customerName, raw.customer_address || raw.bill_to_address);

  // 2. Resolve project (optional).
  const projectId = entry.matched_project_id || null;

  // 3. Compute dates. Default due = issue + 30.
  const issueDate = raw.issue_date || raw.bill_date || raw.invoice_date || todayISO();
  const dueDate = raw.due_date || addDaysISO(issueDate, 30);

  // 4. Compute totals (sanity-check from line sum if main total is 0).
  const linesSum = (raw.lines || []).reduce((s, l) => s + Number(l.amount || 0), 0);
  const total = Number(raw.total) || linesSum || 0;
  const subtotal = Number(raw.subtotal) || (total - Number(raw.tax || 0));

  // 5. Insert invoice header.
  // Status: 'sent' since the user is uploading an invoice they actually sent
  // to a customer. (As opposed to 'draft' which would be for unsent.)
  const invoiceNumber = raw.invoice_number || raw.bill_number || await nextInvoiceNumber();
  const { data: invoice, error: invErr } = await supabase.from('invoices').insert({
    invoice_number: invoiceNumber,
    customer_id: customerId,
    project_id: projectId,
    issue_date: issueDate,
    due_date: dueDate,
    status: 'sent',
    subtotal: subtotal,
    tax: Number(raw.tax || 0),
    total: total,
    amount_paid: 0,
    source_document_id: doc.id,
    created_by: user?.id || null,
  }).select().single();
  if (invErr) throw invErr;

  // 6. Insert invoice lines. Default revenue account: 4000 (Contract Revenue).
  const defaultRevenueId = await getAccountIdByNumber('4000');
  const lines = (raw.lines || []).length ? raw.lines : [{
    description: invoiceNumber ? `Invoice ${invoiceNumber}` : 'Invoice total',
    quantity: 1,
    rate: total,
    amount: total,
  }];

  const lineRows = lines.map((l, idx) => ({
    invoice_id: invoice.id,
    line_number: idx + 1,
    description: String(l.description || `Line ${idx + 1}`).slice(0, 500),
    quantity: Number(l.quantity || 1),
    rate: Number(l.rate || 0),
    amount: Number(l.amount || 0),
    revenue_account_id: defaultRevenueId,
    project_id: projectId,
  }));

  const { error: linesErr } = await supabase.from('invoice_lines').insert(lineRows);
  if (linesErr) {
    // Rollback by voiding (preserves audit trail)
    await supabase.from('invoices').update({
      status: 'void',
      voided_at: new Date().toISOString(),
      voided_reason: 'Materialization rolled back: ' + linesErr.message,
    }).eq('id', invoice.id);
    throw linesErr;
  }

  return { table: 'invoices', id: invoice.id };
}

async function nextInvoiceNumber() {
  const year = new Date().getFullYear();
  try {
    const { data } = await supabase.from('invoices')
      .select('invoice_number')
      .like('invoice_number', `${year}-%`)
      .order('invoice_number', { ascending: false })
      .limit(1);
    if (!data?.length) return `${year}-0001`;
    const last = parseInt(data[0].invoice_number.split('-')[1] || '0', 10);
    return `${year}-${String(last + 1).padStart(4, '0')}`;
  } catch { return `${year}-0001`; }
}

// =============================================================================
// BILL — vendor invoice/receipt → public.bills + public.bill_lines
// =============================================================================
async function materializeBill(entry, doc) {
  const raw = entry.raw_extraction || {};
  const user = getCurrentUser();
  const vendorId = entry.matched_vendor_id || await ensureVendor(raw.vendor_name, doc.id);
  if (!vendorId) throw new Error('No vendor name found in extraction; cannot create bill.');
  const projectId = entry.matched_project_id || null;
  let defaultAccountId = entry.matched_account_id;
  if (!defaultAccountId) {
    const cats = (raw.lines || []).map(l => l.likely_category).filter(Boolean);
    const mode = mostCommon(cats);
    const acctNum = mode ? COA_BY_CATEGORY[mode] : '6999';
    defaultAccountId = await getAccountIdByNumber(acctNum);
  }
  const billDate = raw.bill_date || todayISO();
  const dueDate = raw.due_date || addDaysISO(billDate, 30);
  const linesSum = (raw.lines || []).reduce((s, l) => s + Number(l.amount || 0), 0);
  const total = Number(raw.total) || linesSum || 0;
  const subtotal = Number(raw.subtotal) || (total - Number(raw.tax || 0));
  const { data: bill, error: billErr } = await supabase.from('bills').insert({
    bill_number: raw.bill_number || null,
    vendor_id: vendorId,
    project_id: projectId,
    bill_date: billDate,
    due_date: dueDate,
    status: 'open',
    subtotal: subtotal,
    tax: Number(raw.tax || 0),
    total: total,
    amount_paid: 0,
    attachment_url: doc.storage_path,
    source_document_id: doc.id,
    notes: raw.notes || null,
    created_by: user?.id || null,
  }).select().single();
  if (billErr) throw billErr;
  const lines = (raw.lines || []).length ? raw.lines : [{
    description: raw.bill_number ? `Invoice ${raw.bill_number}` : 'Bill total',
    quantity: 1, rate: total, amount: total, likely_category: 'other',
  }];
  const lineRows = await Promise.all(lines.map(async (l, idx) => {
    const acctNum = l.likely_category && COA_BY_CATEGORY[l.likely_category];
    const lineAccountId = acctNum ? await getAccountIdByNumber(acctNum) : defaultAccountId;
    const costCodeId = await getCostCodeIdForCategory(l.likely_category);
    return {
      bill_id: bill.id,
      line_number: idx + 1,
      description: String(l.description || `Line ${idx + 1}`).slice(0, 500),
      quantity: Number(l.quantity || 1),
      rate: Number(l.rate || 0),
      amount: Number(l.amount || 0),
      expense_account_id: lineAccountId,
      project_id: projectId,
      cost_code_id: costCodeId,
    };
  }));
  const { error: linesErr } = await supabase.from('bill_lines').insert(lineRows);
  if (linesErr) {
    await supabase.from('bills').update({ status: 'void', voided_at: new Date().toISOString(), voided_reason: 'Materialization rolled back: ' + linesErr.message }).eq('id', bill.id);
    throw linesErr;
  }
  return { table: 'bills', id: bill.id };
}

// =============================================================================
// PROJECT — customer PO/contract → public.projects (and customer if needed)
// =============================================================================
async function materializeProject(entry, doc) {
  const raw = entry.raw_extraction || {};
  const customerId = entry.matched_customer_id || await ensureCustomer(raw.customer_name, raw.customer_address);
  if (!customerId) throw new Error('No customer name in extraction; cannot create project.');
  const year = new Date().getFullYear();
  const projectNumber = await nextProjectNumber(year);
  const { data: proj, error } = await supabase.from('projects').insert({
    project_number: projectNumber,
    name: raw.project_name || `Project ${projectNumber}`,
    customer_id: customerId,
    address: raw.project_address || null,
    contract_amount: Number(raw.contract_amount || 0),
    status: 'active',
    start_date: raw.start_date || null,
    estimated_end: raw.estimated_end || null,
    notes: buildProjectNotes(raw),
    source_document_id: doc.id,
  }).select().single();
  if (error) throw error;
  return { table: 'projects', id: proj.id };
}
function buildProjectNotes(raw) {
  const parts = [];
  if (raw.scope_summary) parts.push(`Scope: ${raw.scope_summary}`);
  if (raw.payment_terms) parts.push(`Terms: ${raw.payment_terms}`);
  if (raw.retainage_percent) parts.push(`Retainage: ${raw.retainage_percent}%`);
  if (raw.project_number_on_doc) parts.push(`Customer PO/Contract #: ${raw.project_number_on_doc}`);
  return parts.join(' · ') || null;
}
async function nextProjectNumber(year) {
  const { data } = await supabase.from('projects')
    .select('project_number')
    .like('project_number', `${year}-%`)
    .order('project_number', { ascending: false })
    .limit(1);
  if (!data?.length) return `${year}-001`;
  const lastNum = parseInt(data[0].project_number.split('-')[1] || '0', 10);
  return `${year}-${String(lastNum + 1).padStart(3, '0')}`;
}

// =============================================================================
// BANK STATEMENT
// =============================================================================
async function materializeBankStatement(entry, doc) {
  const raw = entry.raw_extraction || {};
  const user = getCurrentUser();
  if (!raw.transactions?.length) throw new Error('No transactions in extraction.');
  const last4 = raw.account_last4;
  let bankAccountId = null;
  if (last4) {
    const { data } = await supabase.from('bank_accounts').select('id').eq('last4', last4).eq('is_active', true).limit(1);
    bankAccountId = data?.[0]?.id;
  }
  if (!bankAccountId) throw new Error(`Bank account not found for last4 "${last4}". Add the account in Settings → Bank Accounts before approving this statement.`);
  const { data: batch, error: batchErr } = await supabase.from('import_batches').insert({
    bank_account_id: bankAccountId,
    source_format: 'ofx',
    filename: doc.original_filename,
    row_count: raw.transactions.length,
    imported_by: user?.id || null,
    source_document_id: doc.id,
  }).select().single();
  if (batchErr) throw batchErr;
  const txns = raw.transactions.map(t => ({
    bank_account_id: bankAccountId,
    import_batch_id: batch.id,
    date: t.date,
    description: String(t.description || '').slice(0, 500),
    amount: Number(t.amount || 0),
    balance_after: t.balance_after != null ? Number(t.balance_after) : null,
    reconciled: false,
  }));
  const dates = [...new Set(txns.map(t => t.date))];
  if (dates.length) {
    const { data: existing } = await supabase.from('bank_transactions').select('date, amount, description').eq('bank_account_id', bankAccountId).in('date', dates);
    const existingKeys = new Set((existing || []).map(e => `${e.date}|${Number(e.amount)}|${e.description}`));
    const filtered = txns.filter(t => !existingKeys.has(`${t.date}|${Number(t.amount)}|${t.description}`));
    if (filtered.length === 0) {
      await supabase.from('import_batches').update({ row_count: 0 }).eq('id', batch.id);
      return { table: 'import_batches', id: batch.id, note: 'All transactions already imported (deduplicated)' };
    }
    const { error: txErr } = await supabase.from('bank_transactions').insert(filtered);
    if (txErr) throw txErr;
    await supabase.from('import_batches').update({ row_count: filtered.length }).eq('id', batch.id);
  }
  return { table: 'import_batches', id: batch.id };
}

// =============================================================================
// W-9
// =============================================================================
async function materializeW9(entry, doc) {
  const raw = entry.raw_extraction || {};
  const vendorName = raw.legal_name || raw.business_name;
  if (!vendorName) throw new Error('No legal name on W-9; cannot identify vendor.');
  let vendorId = entry.matched_vendor_id;
  if (!vendorId) vendorId = await ensureVendor(vendorName, doc.id);
  const address = [raw.address, raw.city, raw.state, raw.zip].filter(Boolean).join(', ');
  const { error } = await supabase.from('vendors').update({
    name: raw.business_name || raw.legal_name || undefined,
    address: address || undefined,
    is_1099: true,
    tax_id_encrypted: raw.tax_id ? new TextEncoder().encode(raw.tax_id) : null,
    w9_url: doc.storage_path,
    w9_received_date: raw.signed_date || todayISO(),
    source_document_id: doc.id,
  }).eq('id', vendorId);
  if (error) throw error;
  return { table: 'vendors', id: vendorId };
}

// =============================================================================
// Helpers
// =============================================================================
async function ensureVendor(name, sourceDocId) {
  if (!name) return null;
  const { data: existing } = await supabase.from('vendors').select('id').ilike('name', name).limit(1);
  if (existing?.length) return existing[0].id;
  const { data: created, error } = await supabase.from('vendors').insert({
    name: name.slice(0, 200), is_1099: false, payment_method: 'check', source_document_id: sourceDocId,
  }).select().single();
  if (error) throw error;
  return created.id;
}
async function ensureCustomer(name, address) {
  if (!name) return null;
  const { data: existing } = await supabase.from('customers').select('id').or(`name.ilike.${name},company.ilike.${name}`).limit(1);
  if (existing?.length) return existing[0].id;
  const { data: created, error } = await supabase.from('customers').insert({
    name: name.slice(0, 200), company: name.slice(0, 200), billing_address: address || null, payment_terms: 'net_30',
  }).select().single();
  if (error) throw error;
  return created.id;
}
async function getAccountIdByNumber(number) {
  if (!number) return null;
  const { data } = await supabase.from('chart_of_accounts').select('id').eq('account_number', number).eq('is_active', true).limit(1);
  return data?.[0]?.id || null;
}
async function getCostCodeIdForCategory(category) {
  if (!category) return null;
  const codeMap = { material: 'MAT', labor: 'LAB', equipment: 'EQP', subcontract: 'SUB', other: 'OTH' };
  const code = codeMap[category];
  if (!code) return null;
  const { data } = await supabase.from('cost_codes').select('id').eq('code', code).limit(1);
  return data?.[0]?.id || null;
}
function mostCommon(arr) {
  if (!arr.length) return null;
  const counts = new Map();
  arr.forEach(s => counts.set(s, (counts.get(s) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDaysISO(iso, days) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// =============================================================================
// Self-healing orphans
// =============================================================================
export async function healOrphans() {
  const { data: orphans, error } = await supabase
    .from('pending_entries')
    .select('*, documents(*)')
    .eq('status', 'approved')
    .is('created_record_id', null)
    .limit(20);
  if (error) { console.warn('[heal] could not query orphans:', error); return; }
  if (!orphans?.length) return;
  console.log(`[heal] found ${orphans.length} orphaned approval(s), retrying...`);
  for (const orphan of orphans) {
    const result = await materialize(orphan, orphan.documents);
    if (result.ok) console.log(`[heal] healed ${orphan.id} → ${result.table}/${result.id}`);
    else console.warn(`[heal] failed ${orphan.id}:`, result.error);
  }
}
