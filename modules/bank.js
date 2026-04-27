// =============================================================================
// Bank — accounts CRUD + statement transaction view + CSV import
// =============================================================================
import { supabase, q } from '../lib/supabase.js';
import { fmtMoney, fmtDate, escapeHtml } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { confirmDialog, modal } from '../lib/modal.js';
import { sortRows, headerHTML, attachSortHandlers, getSortState } from '../lib/sort.js';

const ACCT_MOD = 'bank_accts';
const TX_MOD = 'bank_tx';

const ACCT_COLUMNS = [
  { key: 'name',            label: 'Name',     type: 'string' },
  { key: 'account_type',    label: 'Type',     type: 'string' },
  { key: 'last4',           label: 'Last 4',   type: 'string' },
  { key: 'is_active',       label: 'Active',   type: 'number', get: r => r.is_active ? 1 : 0 },
  { key: 'current_balance', label: 'Balance',  type: 'number', numeric: true },
  { key: '_actions',        label: '',         sortable: false },
];

const TX_COLUMNS = [
  { key: 'date',          label: 'Date',        type: 'date' },
  { key: 'description',   label: 'Description', type: 'string' },
  { key: 'amount',        label: 'Amount',      type: 'number', numeric: true },
  { key: 'balance_after', label: 'Balance',     type: 'number', numeric: true },
  { key: 'reconciled',    label: 'Reconciled',  type: 'number', get: r => r.reconciled ? 1 : 0 },
];

export async function renderBank(outlet) {
  outlet.innerHTML = `
    <div class="page-head">
      <div class="page-head-left">
        <h1>BANK</h1>
        <div class="page-head-sub">Accounts and transaction feeds</div>
      </div>
      <div class="page-head-right">
        <button class="btn-primary" id="new-bank">+ New Account</button>
      </div>
    </div>
    <div id="bank-area"><div class="empty-state"><div class="big">LOADING</div></div></div>
  `;
  document.getElementById('new-bank').onclick = () => editAccount(null, () => loadAll());
  await loadAll();
}

async function loadAll() {
  const area = document.getElementById('bank-area');
  try {
    const accts = await q(supabase.from('bank_accounts').select('*').order('name'));
    window.__bankAccts = accts;
    if (!accts.length) {
      area.innerHTML = `<div class="empty-state"><div class="big">NO ACCOUNTS</div><div>Click "New Account" to add one.</div></div>`;
      return;
    }
    renderAccounts();
  } catch (e) {
    area.innerHTML = `<div class="empty-state"><div style="color:var(--red)">${escapeHtml(e.message)}</div></div>`;
  }
}

function renderAccounts() {
  const accts = window.__bankAccts || [];
  const area = document.getElementById('bank-area');
  const state = getSortState(ACCT_MOD, { key: 'name', dir: 'asc' });
  const sorted = sortRows(accts, ACCT_COLUMNS, state);
  area.innerHTML = `
    <div class="table-wrap" id="accts-wrap">
      <table class="data">
        <thead><tr>${headerHTML(ACCT_COLUMNS, state)}</tr></thead>
        <tbody>
          ${sorted.map(a => `
            <tr>
              <td><strong>${escapeHtml(a.name)}</strong>${a.institution ? `<div class="muted">${escapeHtml(a.institution)}</div>` : ''}</td>
              <td><span class="pill pill-gray">${(a.account_type || '').toUpperCase()}</span></td>
              <td class="mono">${escapeHtml(a.last4 || '')}</td>
              <td>${a.is_active ? '<span class="pill pill-green">YES</span>' : '<span class="pill pill-red">NO</span>'}</td>
              <td class="numeric">${fmtMoney(a.current_balance || 0)}</td>
              <td>
                <button class="btn-sm btn-ghost view-tx" data-id="${a.id}">View Tx</button>
                <button class="btn-sm btn-ghost import-tx" data-id="${a.id}">Import CSV</button>
                <button class="btn-sm btn-ghost edit-acct" data-id="${a.id}">Edit</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <div id="tx-view" style="margin-top:16px"></div>
  `;
  const acctsWrap = document.getElementById('accts-wrap');
  acctsWrap.querySelectorAll('.edit-acct').forEach(b => {
    b.onclick = () => editAccount(accts.find(a => a.id === b.dataset.id), () => loadAll());
  });
  acctsWrap.querySelectorAll('.view-tx').forEach(b => {
    b.onclick = () => loadTx(b.dataset.id);
  });
  acctsWrap.querySelectorAll('.import-tx').forEach(b => {
    b.onclick = () => importCSV(b.dataset.id, () => loadAll());
  });
  attachSortHandlers(acctsWrap, ACCT_MOD, () => renderAccounts());
}

async function loadTx(bankId) {
  const wrap = document.getElementById('tx-view');
  wrap.innerHTML = `<div class="empty-state"><div class="big">LOADING TX</div></div>`;
  try {
    const tx = await q(supabase.from('bank_transactions').select('*').eq('bank_account_id', bankId).order('date', { ascending: false }).limit(200));
    window.__bankTxRows = tx;
    if (!tx.length) {
      wrap.innerHTML = `<div class="empty-state"><div class="big">NO TRANSACTIONS</div></div>`;
      return;
    }
    renderTx();
  } catch (e) { wrap.innerHTML = `<div style="color:var(--red)">${escapeHtml(e.message)}</div>`; }
}

function renderTx() {
  const tx = window.__bankTxRows || [];
  const wrap = document.getElementById('tx-view');
  const state = getSortState(TX_MOD, { key: 'date', dir: 'desc' });
  const sorted = sortRows(tx, TX_COLUMNS, state);
  wrap.innerHTML = `
    <div class="card">
      <div class="card-header"><div class="section-title">RECENT TRANSACTIONS (last 200)</div></div>
      <div class="table-wrap" id="tx-wrap">
        <table class="data">
          <thead><tr>${headerHTML(TX_COLUMNS, state)}</tr></thead>
          <tbody>
            ${sorted.map(t => `
              <tr>
                <td>${fmtDate(t.date)}</td>
                <td>${escapeHtml(t.description || '')}</td>
                <td class="numeric ${Number(t.amount) < 0 ? 'delta-down' : 'delta-up'}">${fmtMoney(t.amount)}</td>
                <td class="numeric">${t.balance_after != null ? fmtMoney(t.balance_after) : '<span class="muted">—</span>'}</td>
                <td>${t.reconciled ? '<span class="pill pill-green">YES</span>' : '<span class="pill pill-amber">PENDING</span>'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
  attachSortHandlers(document.getElementById('tx-wrap'), TX_MOD, () => renderTx());
}

function editAccount(record, onDone) {
  const isNew = !record;
  const r = record || { name: '', institution: '', last4: '', account_type: 'checking', current_balance: 0, is_active: true };
  modal({
    title: isNew ? 'New Bank Account' : 'Edit Bank Account',
    bodyHTML: `
      <div class="field"><label class="field-label">Account Name *</label><input class="input" id="f-name" value="${escapeHtml(r.name || '')}"></div>
      <div class="field-row">
        <div class="field"><label class="field-label">Institution</label><input class="input" id="f-inst" value="${escapeHtml(r.institution || '')}"></div>
        <div class="field"><label class="field-label">Type</label>
          <select class="select" id="f-type">
            ${['checking','savings','credit','loc'].map(t => `<option value="${t}" ${t === (r.account_type || 'checking') ? 'selected' : ''}>${t.toUpperCase()}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label class="field-label">Last 4</label><input class="input mono" id="f-last4" maxlength="4" value="${escapeHtml(r.last4 || '')}"></div>
        <div class="field"><label class="field-label">Current Balance</label><input class="input numeric" id="f-bal" type="number" step="0.01" value="${r.current_balance || 0}"></div>
      </div>
      <div class="field" style="display:flex;gap:8px;align-items:center">
        <input type="checkbox" id="f-active" ${r.is_active !== false ? 'checked' : ''}>
        <label for="f-active" class="field-label" style="margin:0">Active</label>
      </div>
    `,
    actions: [
      ...(isNew ? [] : [{ label: 'Delete', kind: 'danger', onClick: async () => {
        const ok = await confirmDialog('Delete account?', 'All transactions will lose the link. Confirm?');
        if (!ok) return false;
        try { await q(supabase.from('bank_accounts').delete().eq('id', r.id)); toast('Deleted', { kind: 'success' }); onDone && onDone(); }
        catch (e) { toast('Failed: ' + e.message, { kind: 'error' }); return false; }
      } }]),
      { label: 'Cancel', kind: 'secondary' },
      { label: isNew ? 'Create' : 'Save', kind: 'primary', onClick: async (bg) => {
        const data = {
          name: bg.querySelector('#f-name').value.trim(),
          institution: bg.querySelector('#f-inst').value.trim() || null,
          last4: bg.querySelector('#f-last4').value.trim() || null,
          account_type: bg.querySelector('#f-type').value,
          current_balance: Number(bg.querySelector('#f-bal').value || 0),
          is_active: bg.querySelector('#f-active').checked,
        };
        if (!data.name) { toast('Name is required', { kind: 'error' }); return false; }
        try {
          if (isNew) await q(supabase.from('bank_accounts').insert(data));
          else await q(supabase.from('bank_accounts').update(data).eq('id', r.id));
          toast('Saved', { kind: 'success' });
          onDone && onDone();
        } catch (e) { toast('Save failed: ' + e.message, { kind: 'error' }); return false; }
      } },
    ],
  });
}

function importCSV(bankId, onDone) {
  modal({
    title: 'Import Transactions (CSV)',
    bodyHTML: `
      <p class="muted">Paste CSV (Chase or Capital One format auto-detected). Required columns: Date, Description, Amount.</p>
      <div class="field"><textarea class="input mono" id="f-csv" rows="10" style="font-size:11px" placeholder="Date,Description,Amount,Balance"></textarea></div>
      <div id="parse-status" class="muted" style="margin-top:8px"></div>
    `,
    actions: [
      { label: 'Cancel', kind: 'secondary' },
      { label: 'Import', kind: 'primary', onClick: async (bg) => {
        const csv = bg.querySelector('#f-csv').value.trim();
        if (!csv) { toast('Paste CSV content first', { kind: 'error' }); return false; }
        const rows = parseCSV(csv);
        if (!rows.length) { toast('No data rows parsed', { kind: 'error' }); return false; }
        try {
          const inserts = rows.map(r => ({
            bank_account_id: bankId,
            date: r.date,
            description: r.description.slice(0, 500),
            amount: r.amount,
            balance_after: r.balance,
            reconciled: false,
          }));
          await q(supabase.from('bank_transactions').insert(inserts));
          toast(`Imported ${inserts.length} transactions`, { kind: 'success' });
          onDone && onDone();
        } catch (e) { toast('Import failed: ' + e.message, { kind: 'error' }); return false; }
      } },
    ],
  });
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const head = lines[0].toLowerCase();
  const cols = head.split(',').map(c => c.trim().replace(/"/g, ''));
  const dateIdx = cols.findIndex(c => /(post|trans|date)/i.test(c));
  const descIdx = cols.findIndex(c => /(desc|memo|merchant|payee)/i.test(c));
  const amtIdx = cols.findIndex(c => /amount/i.test(c));
  const balIdx = cols.findIndex(c => /balance/i.test(c));
  if (dateIdx < 0 || descIdx < 0 || amtIdx < 0) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseRow(lines[i]);
    if (!cells || cells.length < Math.max(dateIdx, descIdx, amtIdx) + 1) continue;
    const dateRaw = cells[dateIdx];
    const date = normalizeDate(dateRaw);
    if (!date) continue;
    const amt = Number(String(cells[amtIdx]).replace(/[\$,]/g, '')) || 0;
    out.push({
      date,
      description: (cells[descIdx] || '').replace(/^"|"$/g, ''),
      amount: amt,
      balance: balIdx >= 0 ? (Number(String(cells[balIdx]).replace(/[\$,]/g, '')) || null) : null,
    });
  }
  return out;
}

function parseRow(line) {
  const out = [];
  let cur = '';
  let inq = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inq = !inq; continue; }
    if (c === ',' && !inq) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function normalizeDate(s) {
  if (!s) return null;
  s = s.trim().replace(/^"|"$/g, '');
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    let yr = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${yr}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  }
  return null;
}
