// =============================================================================
// Bills — AP entry with line items, expense accounts, aging
// =============================================================================
import { supabase, q } from '../lib/supabase.js';
import { fmtMoney, fmtDate, fmtDateISO, daysPastDue, escapeHtml } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { confirmDialog, modal } from '../lib/modal.js';
import { sortRows, headerHTML, attachSortHandlers, getSortState } from '../lib/sort.js';

const MOD = 'bills';

const COLUMNS = [
  { key: 'bill_number',    label: 'Bill #',    type: 'string' },
  { key: 'vendor_name',    label: 'Vendor',    type: 'string', get: r => r._vendor?.name || '' },
  { key: 'project_number', label: 'Project',   type: 'string', get: r => r._project?.project_number || '' },
  { key: 'due_date',       label: 'Due',       type: 'date' },
  { key: 'status',         label: 'Status',    type: 'string' },
  { key: 'total',          label: 'Total',     type: 'number', numeric: true },
  { key: 'amount_paid',    label: 'Paid',      type: 'number', numeric: true },
  { key: 'open',           label: 'Open',      type: 'number', numeric: true, get: r => Number(r.total) - Number(r.amount_paid) },
  { key: '_actions',       label: '',          sortable: false },
];

export async function renderBills(outlet) {
  outlet.innerHTML = `
    <div class="page-head">
      <div class="page-head-left">
        <h1>BILLS</h1>
        <div class="page-head-sub">Accounts payable</div>
      </div>
      <div class="page-head-right">
        <button class="btn-primary" id="new-bill">+ New Bill</button>
      </div>
    </div>
    <div id="ap-aging" class="aging-grid"></div>
    <div class="toolbar">
      <input type="search" id="bill-search" placeholder="Search bills…" class="input" style="max-width:280px">
      <select id="bill-status" class="select" style="max-width:160px">
        <option value="">All statuses</option>
        <option value="open">Open</option>
        <option value="partial">Partial</option>
        <option value="paid">Paid</option>
        <option value="void">Void</option>
      </select>
    </div>
    <div id="bill-table-wrap" class="table-wrap"><div class="empty-state"><div class="big">LOADING</div></div></div>
  `;
  document.getElementById('new-bill').onclick = () => editBill(null, () => loadList());
  document.getElementById('bill-search').oninput = () => filterAndRender();
  document.getElementById('bill-status').onchange = () => filterAndRender();
  await loadList();
}

async function loadList() {
  const wrap = document.getElementById('bill-table-wrap');
  try {
    const [bills, vendors, projects, accounts] = await Promise.all([
      q(supabase.from('bills').select('*').order('bill_date', { ascending: false })),
      q(supabase.from('vendors').select('id, name, default_expense_account')),
      q(supabase.from('projects').select('id, project_number, name')),
      q(supabase.from('chart_of_accounts').select('id, account_number, name, type').eq('is_active', true).in('type', ['cogs','expense']).order('account_number')),
    ]);
    const venMap = new Map(vendors.map(v => [v.id, v]));
    const projMap = new Map(projects.map(p => [p.id, p]));
    window.__billsAll = bills.map(b => ({ ...b, _vendor: venMap.get(b.vendor_id), _project: projMap.get(b.project_id) }));
    window.__billVendors = vendors;
    window.__billProjects = projects;
    window.__billAccounts = accounts;
    renderAging(window.__billsAll);
    filterAndRender();
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state"><div style="color:var(--red)">${escapeHtml(e.message)}</div></div>`;
  }
}

function renderAging(bills) {
  const buckets = { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  for (const b of bills) {
    if (b.status === 'void' || b.status === 'paid') continue;
    const open = Number(b.total) - Number(b.amount_paid);
    if (open <= 0) continue;
    const days = daysPastDue(b.due_date);
    if (days <= 0) buckets.current += open;
    else if (days <= 30) buckets['1-30'] += open;
    else if (days <= 60) buckets['31-60'] += open;
    else if (days <= 90) buckets['61-90'] += open;
    else buckets['90+'] += open;
  }
  document.getElementById('ap-aging').innerHTML = `
    ${Object.entries(buckets).map(([k, v]) => `
      <div class="aging-cell">
        <div class="muted">${k.toUpperCase()}</div>
        <div class="big">${fmtMoney(v)}</div>
      </div>
    `).join('')}
  `;
}

function filterAndRender() {
  const all = window.__billsAll || [];
  const term = (document.getElementById('bill-search')?.value || '').trim().toLowerCase();
  const status = document.getElementById('bill-status')?.value || '';
  let rows = all;
  if (term) rows = rows.filter(b =>
    (b.bill_number || '').toLowerCase().includes(term) ||
    (b._vendor?.name || '').toLowerCase().includes(term));
  if (status) rows = rows.filter(b => b.status === status);
  renderTable(rows);
}

function statusPill(s) {
  const map = { open: 'pill-amber', partial: 'pill-purple', paid: 'pill-green', void: 'pill-red' };
  return `<span class="pill ${map[s] || 'pill-gray'}">${(s || '').toUpperCase()}</span>`;
}

function renderTable(rows) {
  const wrap = document.getElementById('bill-table-wrap');
  if (!rows.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="big">NO BILLS</div></div>`;
    return;
  }
  const state = getSortState(MOD, { key: 'due_date', dir: 'desc' });
  const sorted = sortRows(rows, COLUMNS, state);
  wrap.innerHTML = `
    <table class="data">
      <thead><tr>${headerHTML(COLUMNS, state)}</tr></thead>
      <tbody>
        ${sorted.map(b => {
          const open = Number(b.total) - Number(b.amount_paid);
          const days = b.status === 'void' || b.status === 'paid' ? 0 : daysPastDue(b.due_date);
          return `
          <tr>
            <td class="mono">${escapeHtml(b.bill_number || '—')}</td>
            <td>${escapeHtml(b._vendor?.name || '—')}</td>
            <td class="mono">${escapeHtml(b._project?.project_number || '')}</td>
            <td>${fmtDate(b.due_date)}${days > 0 ? `<div class="muted" style="color:var(--red);font-size:11px">${days}d late</div>` : ''}</td>
            <td>${statusPill(b.status)}</td>
            <td class="numeric">${fmtMoney(b.total)}</td>
            <td class="numeric">${fmtMoney(b.amount_paid)}</td>
            <td class="numeric"><strong>${fmtMoney(open)}</strong></td>
            <td><button class="btn-sm btn-ghost edit-btn" data-id="${b.id}">Edit</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
  wrap.querySelectorAll('.edit-btn').forEach(btn => {
    btn.onclick = () => {
      const b = (window.__billsAll || []).find(x => x.id === btn.dataset.id);
      editBill(b, () => loadList());
    };
  });
  attachSortHandlers(wrap, MOD, () => renderTable(rows));
}

async function editBill(record, onDone) {
  const isNew = !record;
  const r = record || { bill_number: '', vendor_id: null, project_id: null, bill_date: fmtDateISO(new Date()), due_date: '', status: 'open', subtotal: 0, tax: 0, total: 0, amount_paid: 0, notes: '' };
  const vendors = window.__billVendors || [];
  const projects = window.__billProjects || [];
  const accounts = window.__billAccounts || [];
  let lines = [];
  if (!isNew) {
    try { lines = await q(supabase.from('bill_lines').select('*').eq('bill_id', r.id).order('line_number')); }
    catch (e) { lines = []; }
  }
  if (!lines.length) lines = [{ description: '', quantity: 1, rate: 0, amount: 0, expense_account_id: null }];
  const venOpts = `<option value="">— Select vendor —</option>` + vendors.map(v => `<option value="${v.id}" ${v.id === r.vendor_id ? 'selected' : ''}>${escapeHtml(v.name)}</option>`).join('');
  const projOpts = `<option value="">— No project —</option>` + projects.map(p => `<option value="${p.id}" ${p.id === r.project_id ? 'selected' : ''}>${escapeHtml(p.project_number || '')} ${escapeHtml(p.name)}</option>`).join('');
  const acctOpts = (sel) => `<option value="">— Account —</option>` + accounts.map(a => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${escapeHtml(a.account_number)} ${escapeHtml(a.name)}</option>`).join('');
  const lineHTML = (l, i) => `
    <tr class="line-row" data-i="${i}">
      <td><input class="input" data-f="description" value="${escapeHtml(l.description || '')}"></td>
      <td><input class="input numeric" data-f="quantity" type="number" step="0.01" value="${l.quantity || 1}" style="width:70px"></td>
      <td><input class="input numeric" data-f="rate" type="number" step="0.01" value="${l.rate || 0}" style="width:90px"></td>
      <td><input class="input numeric" data-f="amount" type="number" step="0.01" value="${l.amount || 0}" style="width:100px"></td>
      <td><select class="select" data-f="expense_account_id">${acctOpts(l.expense_account_id)}</select></td>
      <td><button class="btn-sm btn-ghost rm-line" type="button">×</button></td>
    </tr>`;
  modal({
    title: isNew ? 'New Bill' : `Edit Bill ${r.bill_number || ''}`,
    bodyHTML: `
      <div class="field-row-3">
        <div class="field"><label class="field-label">Bill #</label><input class="input mono" id="f-num" value="${escapeHtml(r.bill_number || '')}"></div>
        <div class="field"><label class="field-label">Vendor *</label><select class="select" id="f-ven">${venOpts}</select></div>
        <div class="field"><label class="field-label">Project</label><select class="select" id="f-proj">${projOpts}</select></div>
      </div>
      <div class="field-row-3">
        <div class="field"><label class="field-label">Bill Date *</label><input class="input" id="f-date" type="date" value="${r.bill_date || ''}"></div>
        <div class="field"><label class="field-label">Due Date *</label><input class="input" id="f-due" type="date" value="${r.due_date || ''}"></div>
        <div class="field"><label class="field-label">Status</label>
          <select class="select" id="f-status">
            ${['open','partial','paid','void'].map(s => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${s.toUpperCase()}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="line-items">
        <table class="data">
          <thead><tr><th>Description</th><th>Qty</th><th>Rate</th><th>Amount</th><th>Account</th><th></th></tr></thead>
          <tbody id="lines-body">${lines.map((l, i) => lineHTML(l, i)).join('')}</tbody>
        </table>
        <button class="btn-sm btn-ghost" type="button" id="add-line">+ Add Line</button>
      </div>
      <div class="field-row-3" style="margin-top:14px">
        <div class="field"><label class="field-label">Subtotal</label><input class="input numeric" id="f-sub" type="number" step="0.01" value="${r.subtotal || 0}" readonly></div>
        <div class="field"><label class="field-label">Tax</label><input class="input numeric" id="f-tax" type="number" step="0.01" value="${r.tax || 0}"></div>
        <div class="field"><label class="field-label">Total</label><input class="input numeric" id="f-total" type="number" step="0.01" value="${r.total || 0}" readonly></div>
      </div>
      <div class="field"><label class="field-label">Notes</label><textarea class="input" id="f-notes" rows="2">${escapeHtml(r.notes || '')}</textarea></div>
    `,
    actions: [
      ...(isNew ? [] : [{ label: 'Void', kind: 'danger', onClick: async (bg) => {
        const ok = await confirmDialog('Void this bill?', 'Sets status to void. Bill stays for audit.');
        if (!ok) return false;
        try {
          await q(supabase.from('bills').update({ status: 'void', voided_at: new Date().toISOString() }).eq('id', r.id));
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
          expense_account_id: row.querySelector('[data-f=expense_account_id]').value || null,
        })).filter(l => l.description || l.amount);
        const subtotal = Number(bg.querySelector('#f-sub').value || 0);
        const tax = Number(bg.querySelector('#f-tax').value || 0);
        const total = Number(bg.querySelector('#f-total').value || 0);
        const data = {
          bill_number: bg.querySelector('#f-num').value.trim() || null,
          vendor_id: bg.querySelector('#f-ven').value || null,
          project_id: bg.querySelector('#f-proj').value || null,
          bill_date: bg.querySelector('#f-date').value,
          due_date: bg.querySelector('#f-due').value,
          status: bg.querySelector('#f-status').value,
          subtotal, tax, total,
          notes: bg.querySelector('#f-notes').value.trim() || null,
        };
        if (!data.vendor_id) { toast('Vendor is required', { kind: 'error' }); return false; }
        if (!data.bill_date || !data.due_date) { toast('Dates are required', { kind: 'error' }); return false; }
        try {
          let billId = r.id;
          if (isNew) {
            const ins = await q(supabase.from('bills').insert({ ...data, amount_paid: 0 }).select().single());
            billId = ins.id;
          } else {
            await q(supabase.from('bills').update(data).eq('id', r.id));
            await q(supabase.from('bill_lines').delete().eq('bill_id', r.id));
          }
          if (collectedLines.length) {
            await q(supabase.from('bill_lines').insert(collectedLines.map(l => ({ ...l, bill_id: billId }))));
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
      tmp.innerHTML = lineHTML({ description: '', quantity: 1, rate: 0, amount: 0, expense_account_id: null }, idx);
      body.appendChild(tmp.querySelector('tr'));
      recalc();
    });
    recalc();
  }, 50);
}
