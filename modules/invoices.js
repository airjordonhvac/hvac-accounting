// =============================================================================
// Invoices — AR with line items, revenue accounts, aging
// =============================================================================
import { supabase, q } from '../lib/supabase.js';
import { fmtMoney, fmtDate, fmtDateISO, daysPastDue, escapeHtml } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { confirmDialog, modal } from '../lib/modal.js';

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
    renderAging(window.__invAll);
    filterAndRender();
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state"><div style="color:var(--red)">${escapeHtml(e.message)}</div></div>`;
  }
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
  wrap.innerHTML = `
    <table class="data">
      <thead><tr>
        <th>Invoice #</th><th>Customer</th><th>Project</th><th>Due</th><th>Status</th>
        <th class="numeric">Total</th><th class="numeric">Paid</th><th class="numeric">Open</th><th></th>
      </tr></thead>
      <tbody>
        ${rows.map(i => {
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
        const data = {
          invoice_number: bg.querySelector('#f-num').value.trim() || null,
          customer_id: bg.querySelector('#f-cust').value || null,
          project_id: bg.querySelector('#f-proj').value || null,
          issue_date: bg.querySelector('#f-date').value,
          due_date: bg.querySelector('#f-due').value,
          status: bg.querySelector('#f-status').value,
          subtotal, tax, total,
        };
        if (!data.customer_id) { toast('Customer is required', { kind: 'error' }); return false; }
        if (!data.issue_date || !data.due_date) { toast('Dates are required', { kind: 'error' }); return false; }
        try {
          let invId = r.id;
          if (isNew) {
            const ins = await q(supabase.from('invoices').insert({ ...data, amount_paid: 0 }).select().single());
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
  setTimeout(() => {
    const body = document.querySelector('#lines-body');
    const recalc = () => {
      let sub = 0;
      body.querySelectorAll('.line-row').forEach(row => {
        const qty = Number(row.querySelector('[data-f=quantity]').value) || 0;
        const rate = Number(row.querySelector('[data-f=rate]').value) || 0;
        const amtIn = row.querySelector('[data-f=amount]');
        if (document.activeElement !== amtIn) amtIn.value = (qty * rate).toFixed(2);
        sub += Number(amtIn.value) || 0;
      });
      document.querySelector('#f-sub').value = sub.toFixed(2);
      const tax = Number(document.querySelector('#f-tax').value) || 0;
      document.querySelector('#f-total').value = (sub + tax).toFixed(2);
    };
    body.addEventListener('input', recalc);
    document.querySelector('#f-tax').addEventListener('input', recalc);
    body.addEventListener('click', (e) => {
      if (e.target.matches('.rm-line')) { e.target.closest('.line-row').remove(); recalc(); }
    });
    document.querySelector('#add-line').addEventListener('click', () => {
      const idx = body.querySelectorAll('.line-row').length;
      const tmp = document.createElement('tbody');
      tmp.innerHTML = lineHTML({ description: '', quantity: 1, rate: 0, amount: 0, revenue_account_id: null }, idx);
      body.appendChild(tmp.querySelector('tr'));
      recalc();
    });
    recalc();
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
