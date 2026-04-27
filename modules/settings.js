// =============================================================================
// Settings — Chart of Accounts editor + tax year locks
// =============================================================================
import { supabase, q } from '../lib/supabase.js';
import { escapeHtml, fmtDate } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { confirmDialog, modal } from '../lib/modal.js';
import { sortRows, headerHTML, attachSortHandlers, getSortState } from '../lib/sort.js';

const COA_MOD = 'coa';
const LOCKS_MOD = 'locks';

const COA_COLUMNS = [
  { key: 'account_number', label: '#',       type: 'string' },
  { key: 'name',           label: 'Name',    type: 'string' },
  { key: 'type',           label: 'Type',    type: 'string' },
  { key: 'is_active',      label: 'Active',  type: 'number', get: r => r.is_active ? 1 : 0 },
  { key: '_actions',       label: '',        sortable: false },
];

const LOCK_COLUMNS = [
  { key: 'tax_year',  label: 'Year',      type: 'number' },
  { key: 'locked_at', label: 'Locked At', type: 'date' },
  { key: '_actions',  label: '',          sortable: false },
];

export async function renderSettings(outlet) {
  outlet.innerHTML = `
    <div class="page-head">
      <div class="page-head-left">
        <h1>SETTINGS</h1>
        <div class="page-head-sub">Chart of accounts, tax year locks</div>
      </div>
    </div>
    <div class="card">
      <div class="card-header">
        <div class="section-title">CHART OF ACCOUNTS</div>
        <div><button class="btn-sm btn-primary" id="new-acct">+ Account</button></div>
      </div>
      <div id="coa-table-wrap" class="table-wrap"><div class="empty-state"><div class="big">LOADING</div></div></div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-header">
        <div class="section-title">TAX YEAR LOCKS</div>
        <div><button class="btn-sm btn-primary" id="new-lock">+ Lock Year</button></div>
      </div>
      <div id="locks-wrap" class="table-wrap"><div class="empty-state"><div class="big">LOADING</div></div></div>
    </div>
  `;
  document.getElementById('new-acct').onclick = () => editAccount(null, () => loadCOA());
  document.getElementById('new-lock').onclick = () => addLock(() => loadLocks());
  await Promise.all([loadCOA(), loadLocks()]);
}

async function loadCOA() {
  try {
    const accounts = await q(supabase.from('chart_of_accounts').select('*').order('account_number'));
    window.__coaAll = accounts;
    if (!accounts.length) {
      document.getElementById('coa-table-wrap').innerHTML =
        `<div class="empty-state"><div class="big">NO ACCOUNTS</div><div>Run the COA seed migration to populate.</div></div>`;
      return;
    }
    renderCOA();
  } catch (e) {
    document.getElementById('coa-table-wrap').innerHTML =
      `<div class="empty-state"><div style="color:var(--red)">${escapeHtml(e.message)}</div></div>`;
  }
}

function renderCOA() {
  const accounts = window.__coaAll || [];
  const wrap = document.getElementById('coa-table-wrap');
  const state = getSortState(COA_MOD, { key: 'account_number', dir: 'asc' });
  const sorted = sortRows(accounts, COA_COLUMNS, state);
  wrap.innerHTML = `
    <table class="data">
      <thead><tr>${headerHTML(COA_COLUMNS, state)}</tr></thead>
      <tbody>
        ${sorted.map(a => `
          <tr>
            <td class="mono">${escapeHtml(a.account_number)}</td>
            <td>${escapeHtml(a.name)}</td>
            <td><span class="pill pill-gray">${escapeHtml(a.type.toUpperCase())}</span></td>
            <td>${a.is_active ? '<span class="pill pill-green">YES</span>' : '<span class="pill pill-red">NO</span>'}</td>
            <td><button class="btn-sm btn-ghost edit-acct" data-id="${a.id}">Edit</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  wrap.querySelectorAll('.edit-acct').forEach(b => {
    b.onclick = () => {
      const a = (window.__coaAll || []).find(x => x.id === b.dataset.id);
      editAccount(a, () => loadCOA());
    };
  });
  attachSortHandlers(wrap, COA_MOD, () => renderCOA());
}

function editAccount(record, onDone) {
  const isNew = !record;
  const r = record || { account_number: '', name: '', type: 'expense', is_active: true };
  modal({
    title: isNew ? 'New Account' : 'Edit Account',
    bodyHTML: `
      <div class="field-row">
        <div class="field"><label class="field-label">Number *</label><input class="input mono" id="f-num" value="${escapeHtml(r.account_number || '')}"></div>
        <div class="field"><label class="field-label">Type</label>
          <select class="select" id="f-type">
            ${['asset','liability','equity','revenue','cogs','expense'].map(t => `<option value="${t}" ${t === r.type ? 'selected' : ''}>${t.toUpperCase()}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field"><label class="field-label">Name *</label><input class="input" id="f-name" value="${escapeHtml(r.name || '')}"></div>
      <div class="field" style="display:flex;gap:8px;align-items:center">
        <input type="checkbox" id="f-active" ${r.is_active !== false ? 'checked' : ''}>
        <label for="f-active" class="field-label" style="margin:0">Active</label>
      </div>
    `,
    actions: [
      { label: 'Cancel', kind: 'secondary' },
      { label: isNew ? 'Create' : 'Save', kind: 'primary', onClick: async (bg) => {
        const data = {
          account_number: bg.querySelector('#f-num').value.trim(),
          name: bg.querySelector('#f-name').value.trim(),
          type: bg.querySelector('#f-type').value,
          is_active: bg.querySelector('#f-active').checked,
        };
        if (!data.account_number || !data.name) { toast('Number and name are required', { kind: 'error' }); return false; }
        try {
          if (isNew) await q(supabase.from('chart_of_accounts').insert(data));
          else await q(supabase.from('chart_of_accounts').update(data).eq('id', r.id));
          toast('Saved', { kind: 'success' });
          onDone && onDone();
        } catch (e) { toast('Save failed: ' + e.message, { kind: 'error' }); return false; }
      } },
    ],
  });
}

async function loadLocks() {
  try {
    const locks = await q(supabase.from('tax_year_locks').select('*').order('tax_year', { ascending: false }));
    window.__locksAll = locks;
    if (!locks.length) {
      document.getElementById('locks-wrap').innerHTML = `<div class="empty-state"><div class="muted">No tax years locked yet.</div></div>`;
      return;
    }
    renderLocks();
  } catch (e) {
    document.getElementById('locks-wrap').innerHTML =
      `<div class="empty-state"><div style="color:var(--red)">${escapeHtml(e.message)}</div></div>`;
  }
}

function renderLocks() {
  const locks = window.__locksAll || [];
  const wrap = document.getElementById('locks-wrap');
  const state = getSortState(LOCKS_MOD, { key: 'tax_year', dir: 'desc' });
  const sorted = sortRows(locks, LOCK_COLUMNS, state);
  wrap.innerHTML = `
    <table class="data">
      <thead><tr>${headerHTML(LOCK_COLUMNS, state)}</tr></thead>
      <tbody>
        ${sorted.map(l => `
          <tr>
            <td class="mono"><strong>${l.tax_year}</strong></td>
            <td>${fmtDate(l.locked_at)}</td>
            <td><button class="btn-sm btn-ghost unlock-btn" data-year="${l.tax_year}">Unlock</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  wrap.querySelectorAll('.unlock-btn').forEach(b => {
    b.onclick = async () => {
      const ok = await confirmDialog('Unlock tax year?', `This will allow edits to year ${b.dataset.year} entries. Confirm?`);
      if (!ok) return;
      try {
        await q(supabase.from('tax_year_locks').delete().eq('tax_year', Number(b.dataset.year)));
        toast('Unlocked', { kind: 'success' });
        loadLocks();
      } catch (e) { toast('Unlock failed: ' + e.message, { kind: 'error' }); }
    };
  });
  attachSortHandlers(wrap, LOCKS_MOD, () => renderLocks());
}

function addLock(onDone) {
  const yr = new Date().getFullYear() - 1;
  modal({
    title: 'Lock Tax Year',
    bodyHTML: `
      <p class="muted">Locks entries dated within the chosen year so they can no longer be edited or deleted.</p>
      <div class="field"><label class="field-label">Tax Year</label><input class="input mono" id="f-yr" type="number" value="${yr}"></div>
    `,
    actions: [
      { label: 'Cancel', kind: 'secondary' },
      { label: 'Lock', kind: 'primary', onClick: async (bg) => {
        const year = Number(bg.querySelector('#f-yr').value);
        if (!year || year < 2000 || year > 2100) { toast('Invalid year', { kind: 'error' }); return false; }
        try {
          await q(supabase.from('tax_year_locks').insert({ tax_year: year }));
          toast('Locked', { kind: 'success' });
          onDone && onDone();
        } catch (e) { toast('Failed: ' + e.message, { kind: 'error' }); return false; }
      } },
    ],
  });
}
