// =============================================================================
// Settings — COA editor + tax year locks + transaction categories + rules
// =============================================================================
import { supabase, q } from '../lib/supabase.js';
import { escapeHtml, fmtDate } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { confirmDialog, modal } from '../lib/modal.js';
import { sortRows, headerHTML, attachSortHandlers, getSortState } from '../lib/sort.js';

const COA_MOD = 'coa';
const LOCKS_MOD = 'locks';
const CAT_MOD = 'cats';
const RULE_MOD = 'rules';

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

const CAT_COLUMNS = [
  { key: 'display_order', label: 'Order',  type: 'number' },
  { key: 'name',          label: 'Name',   type: 'string' },
  { key: 'color',         label: 'Color',  type: 'string', sortable: false },
  { key: 'is_active',     label: 'Active', type: 'number', get: r => r.is_active ? 1 : 0 },
  { key: '_actions',      label: '',       sortable: false },
];

const RULE_COLUMNS = [
  { key: 'priority',     label: 'Priority',   type: 'number' },
  { key: 'match_type',   label: 'Match',      type: 'string' },
  { key: 'match_text',   label: 'When desc.', type: 'string' },
  { key: 'category',     label: 'Category',   type: 'string', get: r => r._cat?.name || '' },
  { key: 'is_active',    label: 'Active',     type: 'number', get: r => r.is_active ? 1 : 0 },
  { key: '_actions',     label: '',           sortable: false },
];

export async function renderSettings(outlet) {
  outlet.innerHTML = `
    <div class="page-head">
      <div class="page-head-left">
        <h1>SETTINGS</h1>
        <div class="page-head-sub">Chart of accounts, categories, rules, tax year locks</div>
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
        <div>
          <div class="section-title">TRANSACTION CATEGORIES</div>
          <div class="muted" style="font-size:11px">Personal-style buckets for tagging bank/credit card transactions</div>
        </div>
        <div><button class="btn-sm btn-primary" id="new-cat">+ Category</button></div>
      </div>
      <div id="cats-wrap" class="table-wrap"><div class="empty-state"><div class="big">LOADING</div></div></div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-header">
        <div>
          <div class="section-title">CATEGORIZATION RULES</div>
          <div class="muted" style="font-size:11px">Auto-assign categories on statement import based on description keywords</div>
        </div>
        <div><button class="btn-sm btn-primary" id="new-rule">+ Rule</button></div>
      </div>
      <div id="rules-wrap" class="table-wrap"><div class="empty-state"><div class="big">LOADING</div></div></div>
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
  document.getElementById('new-cat').onclick = () => editCategory(null, () => loadCats());
  document.getElementById('new-rule').onclick = () => editRule(null, () => loadRules());
  document.getElementById('new-lock').onclick = () => addLock(() => loadLocks());
  await Promise.all([loadCOA(), loadCats(), loadRules(), loadLocks()]);
}

// =============================================================================
// Chart of accounts
// =============================================================================

async function loadCOA() {
  try {
    const accounts = await q(supabase.from('chart_of_accounts').select('*').order('account_number'));
    window.__coaAll = accounts;
    if (!accounts.length) {
      document.getElementById('coa-table-wrap').innerHTML =
        `<div class="empty-state"><div class="big">NO ACCOUNTS</div></div>`;
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

// =============================================================================
// Transaction categories
// =============================================================================

async function loadCats() {
  try {
    const [cats, coa] = await Promise.all([
      q(supabase.from('transaction_categories').select('*').order('display_order')),
      q(supabase.from('chart_of_accounts').select('id, account_number, name').eq('is_active', true).in('type', ['cogs','expense']).order('account_number')),
    ]);
    window.__catsAll = cats;
    window.__coaForCats = coa;
    if (!cats.length) {
      document.getElementById('cats-wrap').innerHTML = `<div class="empty-state"><div class="muted">No categories yet. Run migration 005 or click "+ Category".</div></div>`;
      return;
    }
    renderCats();
  } catch (e) {
    document.getElementById('cats-wrap').innerHTML =
      `<div class="empty-state"><div style="color:var(--red)">${escapeHtml(e.message)}</div></div>`;
  }
}

function renderCats() {
  const cats = window.__catsAll || [];
  const wrap = document.getElementById('cats-wrap');
  const state = getSortState(CAT_MOD, { key: 'display_order', dir: 'asc' });
  const sorted = sortRows(cats, CAT_COLUMNS, state);
  wrap.innerHTML = `
    <table class="data">
      <thead><tr>${headerHTML(CAT_COLUMNS, state)}</tr></thead>
      <tbody>
        ${sorted.map(c => `
          <tr>
            <td class="mono">${c.display_order}</td>
            <td><strong>${escapeHtml(c.name)}</strong></td>
            <td><span style="display:inline-block;width:18px;height:18px;border-radius:3px;background:${c.color || '#888'};vertical-align:middle;margin-right:6px"></span><span class="mono" style="font-size:11px">${c.color || '—'}</span></td>
            <td>${c.is_active ? '<span class="pill pill-green">YES</span>' : '<span class="pill pill-red">NO</span>'}</td>
            <td><button class="btn-sm btn-ghost edit-cat" data-id="${c.id}">Edit</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  wrap.querySelectorAll('.edit-cat').forEach(b => {
    b.onclick = () => {
      const c = (window.__catsAll || []).find(x => x.id === b.dataset.id);
      editCategory(c, () => loadCats());
    };
  });
  attachSortHandlers(wrap, CAT_MOD, () => renderCats());
}

function editCategory(record, onDone) {
  const isNew = !record;
  const r = record || { name: '', display_order: 100, color: '#7B9DD6', coa_account_id: null, is_active: true };
  const coa = window.__coaForCats || [];
  const coaOpts = '<option value="">— None —</option>' + coa.map(a =>
    `<option value="${a.id}" ${a.id === r.coa_account_id ? 'selected' : ''}>${escapeHtml(a.account_number)} — ${escapeHtml(a.name)}</option>`
  ).join('');
  modal({
    title: isNew ? 'New Category' : 'Edit Category',
    bodyHTML: `
      <div class="field"><label class="field-label">Name *</label><input class="input" id="f-name" value="${escapeHtml(r.name || '')}" placeholder="e.g. Travel, Software, Vehicle Fuel"></div>
      <div class="field-row">
        <div class="field"><label class="field-label">Display Order</label><input class="input numeric" id="f-order" type="number" value="${r.display_order}"></div>
        <div class="field"><label class="field-label">Color</label><input class="input" id="f-color" type="color" value="${r.color || '#7B9DD6'}" style="height:38px;padding:2px"></div>
      </div>
      <div class="field"><label class="field-label">Map to COA Account (optional, used at tax export)</label>
        <select class="select" id="f-coa">${coaOpts}</select>
      </div>
      <div class="field" style="display:flex;gap:8px;align-items:center">
        <input type="checkbox" id="f-active" ${r.is_active !== false ? 'checked' : ''}>
        <label for="f-active" class="field-label" style="margin:0">Active</label>
      </div>
    `,
    actions: [
      ...(isNew ? [] : [{ label: 'Delete', kind: 'danger', onClick: async () => {
        const ok = await confirmDialog('Delete category?', 'Transactions tagged with this category will become uncategorized. Confirm?');
        if (!ok) return false;
        try { await q(supabase.from('transaction_categories').delete().eq('id', r.id)); toast('Deleted', { kind: 'success' }); onDone && onDone(); }
        catch (e) { toast('Failed: ' + e.message, { kind: 'error' }); return false; }
      } }]),
      { label: 'Cancel', kind: 'secondary' },
      { label: isNew ? 'Create' : 'Save', kind: 'primary', onClick: async (bg) => {
        const data = {
          name: bg.querySelector('#f-name').value.trim(),
          display_order: Number(bg.querySelector('#f-order').value) || 100,
          color: bg.querySelector('#f-color').value || '#7B9DD6',
          coa_account_id: bg.querySelector('#f-coa').value || null,
          is_active: bg.querySelector('#f-active').checked,
        };
        if (!data.name) { toast('Name is required', { kind: 'error' }); return false; }
        try {
          if (isNew) await q(supabase.from('transaction_categories').insert(data));
          else await q(supabase.from('transaction_categories').update(data).eq('id', r.id));
          toast('Saved', { kind: 'success' });
          onDone && onDone();
        } catch (e) { toast('Save failed: ' + e.message, { kind: 'error' }); return false; }
      } },
    ],
  });
}

// =============================================================================
// Categorization rules
// =============================================================================

async function loadRules() {
  try {
    const [rules, cats] = await Promise.all([
      q(supabase.from('categorization_rules').select('*').order('priority')),
      q(supabase.from('transaction_categories').select('*').eq('is_active', true).order('display_order')),
    ]);
    const catMap = new Map(cats.map(c => [c.id, c]));
    window.__rulesAll = rules.map(r => ({ ...r, _cat: catMap.get(r.category_id) }));
    window.__catsForRules = cats;
    if (!rules.length) {
      document.getElementById('rules-wrap').innerHTML = `<div class="empty-state"><div class="muted">No rules yet. Click "+ Rule" to add keyword auto-categorization.</div></div>`;
      return;
    }
    renderRules();
  } catch (e) {
    document.getElementById('rules-wrap').innerHTML =
      `<div class="empty-state"><div style="color:var(--red)">${escapeHtml(e.message)}</div></div>`;
  }
}

function renderRules() {
  const rules = window.__rulesAll || [];
  const wrap = document.getElementById('rules-wrap');
  const state = getSortState(RULE_MOD, { key: 'priority', dir: 'asc' });
  const sorted = sortRows(rules, RULE_COLUMNS, state);
  wrap.innerHTML = `
    <table class="data">
      <thead><tr>${headerHTML(RULE_COLUMNS, state)}</tr></thead>
      <tbody>
        ${sorted.map(r => `
          <tr>
            <td class="mono">${r.priority}</td>
            <td><span class="pill pill-gray">${(r.match_type || 'contains').toUpperCase()}</span></td>
            <td class="mono" style="font-size:12px">"${escapeHtml(r.match_text)}"</td>
            <td>${r._cat ? `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${r._cat.color};margin-right:6px"></span>${escapeHtml(r._cat.name)}` : '<span class="muted">—</span>'}</td>
            <td>${r.is_active ? '<span class="pill pill-green">YES</span>' : '<span class="pill pill-red">NO</span>'}</td>
            <td><button class="btn-sm btn-ghost edit-rule" data-id="${r.id}">Edit</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  wrap.querySelectorAll('.edit-rule').forEach(b => {
    b.onclick = () => {
      const r = (window.__rulesAll || []).find(x => x.id === b.dataset.id);
      editRule(r, () => loadRules());
    };
  });
  attachSortHandlers(wrap, RULE_MOD, () => renderRules());
}

function editRule(record, onDone) {
  const isNew = !record;
  const r = record || { match_text: '', match_type: 'contains', priority: 100, category_id: null, is_active: true };
  const cats = window.__catsForRules || [];
  const catOpts = '<option value="">— Select category —</option>' + cats.map(c =>
    `<option value="${c.id}" ${c.id === r.category_id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
  ).join('');
  modal({
    title: isNew ? 'New Rule' : 'Edit Rule',
    bodyHTML: `
      <div class="muted" style="margin-bottom:10px">When a bank/credit transaction's description matches the keyword below, it auto-tags with the chosen category.</div>
      <div class="field-row">
        <div class="field"><label class="field-label">Match Type</label>
          <select class="select" id="f-mtype">
            ${['contains','starts_with','exact'].map(t => `<option value="${t}" ${t === r.match_type ? 'selected' : ''}>${t.replace('_',' ').toUpperCase()}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label class="field-label">Priority (lower wins)</label><input class="input numeric" id="f-prio" type="number" value="${r.priority}"></div>
      </div>
      <div class="field"><label class="field-label">When description ${(r.match_type || 'contains').replace('_',' ')} *</label>
        <input class="input mono" id="f-text" value="${escapeHtml(r.match_text || '')}" placeholder='e.g. "Shell" or "AMEX Epayment"'>
      </div>
      <div class="field"><label class="field-label">Then assign category *</label>
        <select class="select" id="f-cat">${catOpts}</select>
      </div>
      <div class="field" style="display:flex;gap:8px;align-items:center">
        <input type="checkbox" id="f-active" ${r.is_active !== false ? 'checked' : ''}>
        <label for="f-active" class="field-label" style="margin:0">Active</label>
      </div>
      <div class="muted" style="font-size:11px;margin-top:6px">Tip: keyword match is case-insensitive. Use "AMEX Epayment" to catch all your American Express auto-pays.</div>
    `,
    actions: [
      ...(isNew ? [] : [{ label: 'Delete', kind: 'danger', onClick: async () => {
        const ok = await confirmDialog('Delete rule?', 'Future transactions matching this rule will no longer auto-categorize.');
        if (!ok) return false;
        try { await q(supabase.from('categorization_rules').delete().eq('id', r.id)); toast('Deleted', { kind: 'success' }); onDone && onDone(); }
        catch (e) { toast('Failed: ' + e.message, { kind: 'error' }); return false; }
      } }]),
      { label: 'Cancel', kind: 'secondary' },
      { label: isNew ? 'Create' : 'Save', kind: 'primary', onClick: async (bg) => {
        const data = {
          match_text: bg.querySelector('#f-text').value.trim(),
          match_type: bg.querySelector('#f-mtype').value,
          priority: Number(bg.querySelector('#f-prio').value) || 100,
          category_id: bg.querySelector('#f-cat').value || null,
          is_active: bg.querySelector('#f-active').checked,
        };
        if (!data.match_text) { toast('Match text is required', { kind: 'error' }); return false; }
        if (!data.category_id) { toast('Pick a category', { kind: 'error' }); return false; }
        try {
          if (isNew) await q(supabase.from('categorization_rules').insert(data));
          else await q(supabase.from('categorization_rules').update(data).eq('id', r.id));
          toast('Saved', { kind: 'success' });
          onDone && onDone();
        } catch (e) { toast('Save failed: ' + e.message, { kind: 'error' }); return false; }
      } },
    ],
  });
}

// =============================================================================
// Tax year locks
// =============================================================================

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
