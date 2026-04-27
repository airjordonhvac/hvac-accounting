// =============================================================================
// Invoices — AR with line items, revenue accounts, summary band, aging
// =============================================================================
import { supabase, q } from '../lib/supabase.js';
import { fmtMoney, fmtDate, fmtDateISO, daysPastDue, escapeHtml } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { confirmDialog, modal } from '../lib/modal.js';
import { sortRows, headerHTML, attachSortHandlers, getSortState } from '../lib/sort.js';

const MOD = 'invoices';

const COLUMNS = [
  { key: 'invoice_number', label: 'Invoice #', type: 'string' },
  { key: 'customer_name',  label: 'Customer',  type: 'string', get: r => r._customer?.name || '' },
  { key: 'project_number', label: 'Project',   type: 'string', get: r => r._project?.project_number || '' },
  { key: 'due_date',       label: 'Due',       type: 'date' },
  { key: 'status',         label: 'Status',    type: 'string' },
  { key: 'total',          label: 'Total',     type: 'number', numeric: true },
  { key: 'amount_paid',    label: 'Paid',      type: 'number', numeric: true },
  { key: 'open',           label: 'Open',      type: 'number', numeric: true, get: r => Number(r.total) - Number(r.amount_paid) },
  { key: '_actions',       label: '',          sortable: false },
];

export async function renderInvoices(outlet) {
  outlet.innerHTML = `
    <div class="page-head">
      <div class="page-head-left">
        <h1>INVOICES</h1>
        <div class="page-head-sub">Accounts receivable</div>
      </div>
      <div class="page-head-right">
        <button class="btn-primary" id="new-inv">+ New Invoice</button>
      </div>
    </div>
    <div id="ar-summary" class="summary-grid"></div>
    <div id="ar-aging" class="aging-grid"></div>
    <div class="toolbar">
      <input type="search" id="inv-search" placeholder="Search invoices…" class="input" style="max-width:280px">
      <select id="inv-status" class="select" style="max-width:160px">
        <option value="">All statuses</option>
        <option value="draft">Draft</option>
        <option value="sent">Sent</option>
        <option value="partial">Partial</option>
        <option value="paid">Paid</option>
        <option value="void">Void</option>
      </select>
    </div>
    <div id="inv-table-wrap" class="table-wrap"><div class="empty-state"><div class="big">LOADING</div></div></div>
  `;
  document.getElementById('new-inv').onclick = () => editInvoice(null, () => loadList());
  document.getElementById('inv-search').oninput = () => filterAndRender();
  document.getElementById('inv-status').onchange = () => filterAndRender();
  await loadList();
}

async function loadList() {
  const wrap = document.getElementById('inv-table-wrap');
  try {
    const [invoices, customers, projects, accounts] = await Promise.all([
      q(supabase.from('invoices').select('*').order('issue_date', { ascending: false })),
      q(supabase.from('customers').select('id, name, company, payment_terms')),
      q(supabase.from('projects').select('id, project_number, name, customer_id')),
      q(supabase.from('chart_of_accounts').select('id, account_number, name, type').eq('is_active', true).eq('type', 'revenue').order('account_number')),
    ]);
    const custMap = new Map(customers.map(c => [c.id, c]));
    const projMap = new Map(projects.map(p => [p.id, p]));
    window.__invAll = invoices.map(i => ({ ...i, _customer: custMap.get(i.customer_id), _project: projMap.get(i.project_id) }));
    window.__invCustomers = customers;
    window.__invProjects = projects;
    window.__invAccounts = accounts;
    renderSummary(window.__invAll);
    renderAging(window.__invAll);
    filterAndRender();
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state"><div style="color:var(--red)">${escapeHtml(e.message)}</div></div>`;
  }
}

function renderSummary(invoices) {
  let billed = 0, collected = 0, open = 0, overdue = 0;
  let paidCt = 0, partialCt = 0, sentCt = 0, draftCt = 0;
  for (const inv of invoices) {
    if (inv.status === 'void') continue;
    const t = Number(inv.total) || 0;
    const p = Number(inv.amount_paid) || 0;
    if (inv.status === 'draft') { draftCt++; continue; }
    billed += t;
    collected += p;
    open += (t - p);
    if (inv.status === 'paid') paidCt++;
    else if (inv.status === 'partial') partialCt++;
    else if (inv.status === 'sent') sentCt++;
    if (inv.status !== 'paid' && (t - p) > 0 && daysPastDue(inv.due_date) > 0) {
      overdue += (t - p);
    }
  }
  const collectedPct = billed > 0 ? (collected / billed * 100) : 0;
  document.getElementById('ar-summary').innerHTML = `
    <div class="summary-cell">
      <div class="muted">BILLED</div>
      <div class="big">${fmtMoney(billed)}</div>
      <div class="muted" style="font-size:11px">${sentCt + partialCt + paidCt} invoices${draftCt ? ` (+ ${draftCt} draft)` : ''}</div>
    </div>
    <div class="summary-cell">
      <div class="muted">COLLECTED</div>
      <div class="big" style="color:var(--green)">${fmtMoney(collected)}</div>
      <div class="muted" style="font-size:11px">${collectedPct.toFixed(1)}% of billed</div>
    </div>
    <div class="summary-cell">
      <div class="muted">OPEN</div>
      <div class="big">${fmtMoney(open)}</div>
      <div class="muted" style="font-size:11px">across ${sentCt + partialCt} invoices</div>
    </div>
    <div class="summary-cell">
      <div class="muted">PAID / PARTIAL</div>
      <div class="big">${paidCt} / ${partialCt}</div>
      <div class="muted" style="font-size:11px">paid · partially paid</div>
    </div>
    <div class="summary-cell">
      <div class="muted">OVERDUE</div>
      <div class="big" style="color:var(--red)">${fmtMoney(overdue)}</div>
      <div class="muted" style="font-size:11px">past due date</div>
    </div>
  `;
}

function renderAging(invoices) {
  const buckets = { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  for (const inv of invoices) {
    if (inv.status === 'void' || inv.status === 'paid' || inv.status === 'draft') continue;
    const open = Number(inv.total) - Number(inv.amount_paid);
    if (open <= 0) continue;
    const days = daysPastDue(inv.due_date);
    if (days <= 0) buckets.current += open;
    else if (days <= 30) buckets['1-30'] += open;
    else if (days <= 60) buckets['31-60'] += open;
    else if (days <= 90) buckets['61-90'] += open;
    else buckets['90+'] += open;
  }
  document.getElementById('ar-aging').innerHTML = Object.entries(buckets).map(([k, v]) => `
    <div class="aging-cell">
      <div class="muted">${k.toUpperCase()}</div>
      <div class="big">${fmtMoney(v)}</div>
    </div>
  `).join('');
}

function filterAndRender() {
  const all = window.__invAll || [];
  const term = (document.getElementById('inv-search')?.value || '').trim().toLowerCase();
  const status = document.getElementById('inv-status')?.value || '';
  let rows = all;
  if (term) rows = rows.filter(i =>
    (i.invoice_number || '').toLowerCase().includes(term) ||
    (i._customer?.name || '').toLowerCase().includes(term));
  if (status) rows = rows.filter(i => i.status === status);
  renderTable(rows);
}

function statusPill(s) {
  const map = { draft: 'pill-gray', sent: 'pill-amber', partial: 'pill-purple', paid: 'pill-green', void: 'pill-red' };
  return `<span class="pill ${map[s] || 'pill-gray'}">${(s || '').toUpperCase()}</span>`;
}

function renderTable(rows) {
  const wrap = document.getElementById('inv-table-wrap');
  if (!rows.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="big">NO INVOICES</div></div>`;
    return;
  }
  const state = getSortState(MOD, { key: 'due_date', dir: 'desc' });
  const sorted = sortRows(rows, COLUMNS, state);
  wrap.innerHTML = `
    <table class="data">
      <thead><tr>${headerHTML(COLUMNS, state)}</tr></thead>
      <tbody>
        ${sorted.map(i => {
          const open = Number(i.total) - Number(i.amount_paid);
          const days = (i.status === 'void' || i.status === 'paid' || i.status === 'draft') ? 0 : daysPastDue(i.due_date);
          return `
          <tr>
            <td class="mono">${escapeHtml(i.invoice_number || '—')}</td>
            <td>${escapeHtml(i._customer?.name || '—')}</td>
            <td class="mono">${escapeHtml(i._project?.project_number || '')}</td>
            <td>${fmtDate(i.due_date)}${days > 0 ? `<div class="muted" style="color:var(--red);font-size:11px">${days}d late</div>` : ''}</td>
            <td>${statusPill(i.status)}</td>
            <td class="numeric">${fmtMoney(i.total)}</td>
            <td class="numeric">${fmtMoney(i.amount_paid)}</td>
            <td class="numeric"><strong>${fmtMoney(open)}</strong></td>
            <td><button class="btn-sm btn-ghost edit-btn" data-id="${i.id}">Edit</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
  wrap.querySelectorAll('.edit-btn').forEach(btn => {
    btn.onclick = () => {
      const inv = (window.__invAll || []).find(x => x.id === btn.dataset.id);
      editInvoice(inv, () => loadList());
    };
  });
  attachSortHandlers(wrap, MOD, () => renderTable(rows));
}

async function editInvoice(record, onDone) {
  const isNew = !record;
  const r = record || { invoice_number: '', customer_id: null, project_id: null, issue_date: fmtDateISO(new Date()), due_date: '', status: 'draft', subtotal: 0, tax: 0, total: 0, amount_paid: 0 };
  const customers = window.__invCustomers || [];
  const projects = window.__invProjects || [];
  const accounts = window.__invAccounts || [];
  let lines = [];
  if (!isNew) {
    try { lines = await q(supabase.from('invoice_lines').select('*').eq('invoice_id', r.id).order('line_number')); }
    catch { lines = []; }
  }
  if (!lines.length) lines = [{ description: '', quantity: 1, rate: 0, amount: 0, revenue_account_id: null }];
  const custOpts = `<option value="">— Select customer —</option>` + customers.map(c => `<option value="${c.id}" ${c.id === r.customer_id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
  const projOpts = `<option value="">— No project —</option>` + projects.map(p => `<option value="${p.id}" ${p.id === r.project_id ? 'selected' : ''}>${escapeHtml(p.project_number || '')} ${escapeHtml(p.name)}</option>`).join('');
  const acctOpts = (sel) => `<option value="">— Account —</option>` + accounts.map(a => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${escapeHtml(a.account_number)} ${escapeHtml(a.name)}</option>`).join('');
  const lineHTML = (l, i) => `
    <tr class="line-row" data-i="${i}">
      <td><input class="input" data-f="description" value="${escapeHtml(l.description || '')}"></td>
      <td><input class="input numeric" data-f="quantity" type="number" step="0.01" value="${l.quantity || 1}" style="width:70px"></td>
      <td><input class="input numeric" data-f="rate" type="number" step="0.01" value="${l.rate || 0}" style="width:90px"></td>
      <td><input class="input numeric" data-f="amount" type="number" step="0.01" value="${l.amount || 0}" style="width:100px"></td>
      <td><select class="select" data-f="revenue_account_id">${acctOpts(l.revenue_account_id)}</select></td>
      <td><button class="btn-sm btn-ghost rm-line" type="button">×</button></td>
    </tr>`;
  const generatedNum = isNew ? await nextInvoiceNumber() : r.invoice_number;
  // Show payment fieldset only when status implies money was received (partial/paid).
  // Hidden by default for draft/sent — toggled visible on status change in JS below.
  const showPayBlock = (r.status === 'partial' || r.status === 'paid');
  modal({
    title: isNew ? 'New Invoice' : `Edit Invoice ${r.invoice_number || ''}`,
    bodyHTML: `
      <div class="field-row-3">
        <div class="field"><label class="field-label">Invoice #</label><input class="input mono" id="f-num" value="${escapeHtml(generatedNum || '')}"></div>
        <div class="field"><label class="field-label">Customer *</label><select class="select" id="f-cust">${custOpts}</select></div>
        <div class="field"><label class="field-label">Project</label><select class="select" id="f-proj">${projOpts}</select></div>
      </div>
      <div class="field-row-3">
        <div class="field"><label class="field-label">Issue Date *</label><input class="input" id="f-date" type="date" value="${r.issue_date || ''}"></div>
        <div class="field"><label class="field-label">Due Date *</label><input class="input" id="f-due" type="date" value="${r.due_date || ''}"></div>
        <div class="field"><label class="field-label">Status</label>
          <select class="select" id="f-status">
            ${['draft','sent','partial','paid','void'].map(s => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${s.toUpperCase()}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="line-items">
        <table class="data">
          <thead><tr><th>Description</th><th>Qty</th><th>Rate</th><th>Amount</th><th>Revenue Account</th><th></th></tr></thead>
          <tbody id="lines-body">${lines.map((l, i) => lineHTML(l, i)).join('')}</tbody>
        </table>
        <button class="btn-sm btn-ghost" type="button" id="add-line">+ Add Line</button>
      </div>
      <div class="field-row-3" style="margin-top:14px">
        <div class="field"><label class="field-label">Subtotal</label><input class="input numeric" id="f-sub" type="number" step="0.01" value="${r.subtotal || 0}" readonly></div>
        <div class="field"><label class="field-label">Tax</label><input class="input numeric" id="f-tax" type="number" step="0.01" value="${r.tax || 0}"></div>
        <div class="field"><label class="field-label">Total</label><input class="input numeric" id="f-total" type="number" step="0.01" value="${r.total || 0}" readonly></div>
      </div>
      <div id="pay-block" style="border-top:1px solid var(--hairline); margin-top:14px; padding-top:14px; ${showPayBlock ? '' : 'display:none;'}">
        <div class="section-title" style="margin-bottom:10px">PAYMENT RECEIVED</div>
        <div class="field-row-3">
          <div class="field"><label class="field-label">Paid Amount</label><input class="input numeric" id="f-paid" type="number" step="0.01" value="${r.amount_paid || 0}"></div>
          <div class="field"><label class="field-label">Open Balance</label><input class="input numeric" id="f-open" type="number" readonly value="${(Number(r.total) - Number(r.amount_paid)).toFixed(2)}"></div>
          <div class="field"><label class="field-label">% Collected</label><input class="input numeric" id="f-pct" type="text" readonly value="${(Number(r.total) > 0 ? (Number(r.amount_paid) / Number(r.total) * 100) : 0).toFixed(1)}%"></div>
        </div>
        <div class="muted" style="font-size:11px;margin-top:6px" id="pay-hint">
          Type the amount actually received against this invoice. Status auto-adjusts:
          0 = SENT · partial = PARTIAL · full = PAID.
        </div>
      </div>
    `,
    actions: [
      ...(isNew ? [] : [{ label: 'Void', kind: 'danger', onClick: async () => {
        const ok = await confirmDialog('Void this invoice?', 'Sets status to void.');
        if (!ok) return false;
        try {
          await q(supabase.from('invoices').update({ status: 'void', voided_at: new Date().toISOString() }).eq('id', r.id));
          toast('Voided', { kind: 'success' });
          onDone && onDone();
        } catch (e) { toast('Failed: ' + e.message, { kind: 'error' }); return false; }
      } }]),
      { label: 'Cancel', kind: 'secondary' },
      { label: isNew ? 'Create' : 'Save', kind: 'primary', onClick: async (bg) => {
        const collectedLines = [...bg.querySelectorAll('.line-row')].map((row, idx) => ({
          line_number: idx + 1,
          description: row.querySelector('[data-f=description]').value.trim(),
          quantity: Number(row.querySelector('[data-f=quantity]').value) || 0,
          rate: Number(row.querySelector('[data-f=rate]').value) || 0,
          amount: Number(row.querySelector('[data-f=amount]').value) || 0,
          revenue_account_id: row.querySelector('[data-f=revenue_account_id]').value || null,
        })).filter(l => l.description || l.amount);
        const subtotal = Number(bg.querySelector('#f-sub').value || 0);
        const tax = Number(bg.querySelector('#f-tax').value || 0);
        const total = Number(bg.querySelector('#f-total').value || 0);

        // Resolve final amount_paid + status. Rules:
        // - status=draft  -> paid forced to 0
        // - status=sent   -> paid forced to 0
        // - status=partial-> paid is whatever user typed (must be > 0 and < total)
        // - status=paid   -> paid forced to total
        // - status=void   -> handled via Void button above; not selectable here normally
        let status = bg.querySelector('#f-status').value;
        let amount_paid = 0;
        const payInput = bg.querySelector('#f-paid');
        const typed = payInput ? Number(payInput.value || 0) : 0;
        if (status === 'paid') {
          amount_paid = total;
        } else if (status === 'partial') {
          if (typed <= 0) { toast('Partial status requires a Paid Amount > 0', { kind: 'error' }); return false; }
          if (typed >= total) {
            // Auto-promote to paid if user typed full amount on partial
            status = 'paid';
            amount_paid = total;
          } else {
            amount_paid = typed;
          }
        } else if (status === 'sent' || status === 'draft') {
          amount_paid = 0;
        } else {
          amount_paid = typed;
        }

        const data = {
          invoice_number: bg.querySelector('#f-num').value.trim() || null,
          customer_id: bg.querySelector('#f-cust').value || null,
          project_id: bg.querySelector('#f-proj').value || null,
          issue_date: bg.querySelector('#f-date').value,
          due_date: bg.querySelector('#f-due').value,
          status,
          subtotal, tax, total, amount_paid,
        };
        if (!data.customer_id) { toast('Customer is required', { kind: 'error' }); return false; }
        if (!data.issue_date || !data.due_date) { toast('Dates are required', { kind: 'error' }); return false; }
        try {
          let invId = r.id;
          if (isNew) {
            const ins = await q(supabase.from('invoices').insert(data).select().single());
            invId = ins.id;
          } else {
            await q(supabase.from('invoices').update(data).eq('id', r.id));
            await q(supabase.from('invoice_lines').delete().eq('invoice_id', r.id));
          }
          if (collectedLines.length) {
            await q(supabase.from('invoice_lines').insert(collectedLines.map(l => ({ ...l, invoice_id: invId }))));
          }
          toast('Saved', { kind: 'success' });
          onDone && onDone();
        } catch (e) { toast('Save failed: ' + e.message, { kind: 'error' }); return false; }
      } },
    ],
  });

  // Wire up modal interactions after DOM mounts
  setTimeout(() => {
    const modalEl = document.querySelector('.modal');
    if (!modalEl) return;
    const body = modalEl.querySelector('#lines-body');
    const totalEl = modalEl.querySelector('#f-total');
    const subEl = modalEl.querySelector('#f-sub');
    const taxEl = modalEl.querySelector('#f-tax');
    const statusEl = modalEl.querySelector('#f-status');
    const payBlock = modalEl.querySelector('#pay-block');
    const paidEl = modalEl.querySelector('#f-paid');
    const openEl = modalEl.querySelector('#f-open');
    const pctEl = modalEl.querySelector('#f-pct');

    const recalcLines = () => {
      let sub = 0;
      body.querySelectorAll('.line-row').forEach(row => {
        const qty = Number(row.querySelector('[data-f=quantity]').value) || 0;
        const rate = Number(row.querySelector('[data-f=rate]').value) || 0;
        const amtIn = row.querySelector('[data-f=amount]');
        if (document.activeElement !== amtIn) amtIn.value = (qty * rate).toFixed(2);
        sub += Number(amtIn.value) || 0;
      });
      subEl.value = sub.toFixed(2);
      const tax = Number(taxEl.value) || 0;
      totalEl.value = (sub + tax).toFixed(2);
      recalcPayment();
    };

    const recalcPayment = () => {
      if (!payBlock || payBlock.style.display === 'none') return;
      const total = Number(totalEl.value) || 0;
      const paid = Number(paidEl.value) || 0;
      openEl.value = (total - paid).toFixed(2);
      pctEl.value = (total > 0 ? (paid / total * 100) : 0).toFixed(1) + '%';
    };

    const togglePayBlockForStatus = (newStatus) => {
      if (newStatus === 'partial' || newStatus === 'paid') {
        payBlock.style.display = '';
        // If switching to paid, auto-fill paid = total. If switching to partial and paid is 0, leave blank for user input.
        if (newStatus === 'paid') {
          paidEl.value = (Number(totalEl.value) || 0).toFixed(2);
        }
        recalcPayment();
      } else {
        payBlock.style.display = 'none';
      }
    };

    body.addEventListener('input', recalcLines);
    taxEl.addEventListener('input', recalcLines);
    if (paidEl) paidEl.addEventListener('input', recalcPayment);
    statusEl.addEventListener('change', () => togglePayBlockForStatus(statusEl.value));

    body.addEventListener('click', (e) => {
      if (e.target.matches('.rm-line')) { e.target.closest('.line-row').remove(); recalcLines(); }
    });
    modalEl.querySelector('#add-line').addEventListener('click', () => {
      const idx = body.querySelectorAll('.line-row').length;
      const tmp = document.createElement('tbody');
      tmp.innerHTML = lineHTML({ description: '', quantity: 1, rate: 0, amount: 0, revenue_account_id: null }, idx);
      body.appendChild(tmp.querySelector('tr'));
      recalcLines();
    });
    recalcLines();
  }, 50);
}

async function nextInvoiceNumber() {
  const year = new Date().getFullYear();
  try {
    const data = await q(supabase.from('invoices').select('invoice_number').like('invoice_number', `${year}-%`).order('invoice_number', { ascending: false }).limit(1));
    if (!data.length) return `${year}-0001`;
    const last = parseInt(data[0].invoice_number.split('-')[1] || '0', 10);
    return `${year}-${String(last + 1).padStart(4, '0')}`;
  } catch { return `${year}-0001`; }
}
