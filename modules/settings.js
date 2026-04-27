// =============================================================================
// Settings — Categories & Rules + Chart of Accounts editor + tax year locks
// =============================================================================
import { supabase, q } from '../lib/supabase.js';
import { escapeHtml, fmtDate } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { confirmDialog, modal } from '../lib/modal.js';
import { sortRows, headerHTML, attachSortHandlers, getSortState } from '../lib/sort.js';

const COA_MOD = 'coa';
const LOCKS_MOD = 'locks';
const CAT_MOD = 'categories';
const RULES_MOD = 'rules';

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
  { key: 'name',          label: 'Name',     type: 'string' },
  { key: 'display_order', label: 'Order',    type: 'number' },
  { key: 'rule_count',    label: 'Rules',    type: 'number', get: r => r._ruleCount || 0 },
  { key: 'is_active',     label: 'Active',   type: 'number', get: r => r.is_active ? 1 : 0 },
  { key: '_actions',      label: '',         sortable: false },
];

const RULE_COLUMNS = [
  { key: 'match_text',     label: 'When description…', type: 'string' },
  { key: 'match_type',     label: 'Match',             type: 'string' },
  { key: 'category_name',  label: '→ Category',        type: 'string', get: r => r._categoryName || '' },
  { key: 'priority',       label: 'Priority',          type: 'number' },
  { key: 'is_active',      label: 'Active',            type: 'number', get: r => r.is_active ? 1 : 0 },
  { key: '_actions',       label: '',                  sortable: false },
];

export async function renderSettings(outlet) {
  outlet.innerHTML = `
    <div class="page-head">
      <div class="page-head-left">
        <h1>SETTINGS</h1>
        <div class="page-head-sub">Categories, rules, chart of accounts, tax year locks</div>
      </div>
    </div>

    <!-- Transaction Categories card -->
    <div class="card">
      <div class="card-header">
        <div class="section-title">TRANSACTION CATEGORIES</div>
        <div><button class="btn-sm btn-primary" id="new-cat">+ Category</button></div>
      </div>
      <div id="cat-table-wrap" class="table-wrap"><div class="empty-state"><div class="big">LOADING</div></div></div>
    </div>

    <!-- Categorization Rules card -->
    <div class="card" style="margin-top:16px">
      <div class="card-header">
        <div class="section-title">AUTO-CATEGORIZATION RULES</div>
        <div><button class="btn-sm btn-primary" id="new-rule">+ Rule</button></div>
      </div>
      <div class="muted" style="font-size:11px;padding:0 16px 8px">When a bank transaction's description matches a rule, it's automatically assigned to that category. Rules apply on import. To apply to existing transactions, click "Apply Rules to All" on the Bank page.</div>
      <div id="rules-table-wrap" class="table-wrap"><div class="empty-state"><div class="big">LOADING</div></div></div>
    </div>

    <!-- Chart of Accounts card -->
    <div class="card" style="margin-top:16px">
      <div class="card-header">
        <div class="section-title">CHART OF ACCOUNTS</div>
        <div><button class="btn-sm btn-primary" id="new-acct">+ Account</button></div>
      </div>
      <div id="coa-table-wrap" class="table-wrap"><div class="empty-state"><div class="big">LOADING</div></div></div>
    </div>

    <!-- Tax Year Locks card -->
    <div class="card" style="margin-top:16px">
      <div class="card-header">
        <div class="section-title">TAX YEAR LOCKS</div>
        <div><button class="btn-sm btn-primary" id="new-lock">+ Lock Year</button></div>
      </div>
      <div id="locks-wrap" class="table-wrap"><div class="empty-state"><div class="big">LOADING</div></div></div>
    </div>
  `;
  document.getElementById('new-cat').onclick = () => editCategory(null, () => loadCats());
  document.getElementById('new-rule').onclick = () => editRule(null, () => loadRules());
  document.getElementById('new-acct').onclick = () => editAccount(null, () => loadCOA());
  document.getElementById('new-lock').onclick = () => addLock(() => loadLocks());
  await Promise.all([loadCats(), loadRules(), loadCOA(), loadLocks()]);
}

// =============================================================================
// Categories
// =============================================================================

async function loadCats() {
  try {
    const [cats, rules] = await Promise.all([
      q(supabase.from('transaction_categories').select('*').order('display_order')),
      q(supabase.from('categorization_rules').select('id, category_id')),
    ]);
    const ruleCt = new Map();
    for (const r of rules) ruleCt.set(r.category_id, (ruleCt.get(r.category_id) || 0) + 1);
    window.__catsAll = cats.map(c => ({ ...c, _ruleCount: ruleCt.get(c.id) || 0 }));
    if (!cats.length) {
      document.getElementById('cat-table-wrap').innerHTML =
        `<div class="empty-state"><div class="big">NO CATEGORIES</div><div>Run migration 005 to seed defaults.</div></div>`;
      return;
    }
    renderCats();
  } catch (e) {
    document.getElementById('cat-table-wrap').innerHTML =
      `<div class="empty-state"><div style="color:var(--red)">${escapeHtml(e.message)}</div></div>`;
  }
}

function renderCats() {
  const cats = window.__catsAll || [];
  const wrap = document.getElementById('cat-table-wrap');
  const state = getSortState(CAT_MOD, { key: 'display_order', dir: 'asc' });
  const sorted = sortRows(cats, CAT_COLUMNS, state);
  wrap.innerHTML = `
    <table class="data">
      <thead><tr>${headerHTML(CAT_COLUMNS, state)}</tr></thead>
      <tbody>
        ${sorted.map(c => `
          <tr>
            <td><span style="display:inline-block;width:10px;height:10px;background:${c.color || '#888'};border-radius:2px;margin-right:8px;vertical-align:middle"></span><strong>${escapeHtml(c.name)}</strong></td>
            <td class="numeric">${c.display_order}</td>
            <td class="numeric">${c._ruleCount}</td>
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
      editCategory(c, () => { loadCats(); loadRules(); });
    };
  });
  attachSortHandlers(wrap, CAT_MOD, () => renderCats());
}

function editCategory(record, onDone) {
  const isNew = !record;
  const r = record || { name: '', display_order: 100, color: '#7B9DD6', is_active: true };
  modal({
    title: isNew ? 'New Category' : 'Edit Category',
    bodyHTML: `
      <div class="field"><label class="field-label">Name *</label><input class="input" id="f-name" value="${escapeHtml(r.name || '')}"></div>
      <div class="field-row">
        <div class="field"><label class="field-label">Display Order</label><input class="input numeric" id="f-order" type="number" value="${r.display_order || 100}"></div>
        <div class="field"><label class="field-label">Color</label><input class="input mono" id="f-color" type="color" value="${r.color || '#7B9DD6'}" style="height:36px;padding:2px;width:100px"></div>
      </div>
      <div class="field" style="display:flex;gap:8px;align-items:center">
        <input type="checkbox" id="f-active" ${r.is_active !== false ? 'checked' : ''}>
        <label for="f-active" class="field-label" style="margin:0">Active</label>
      </div>
    `,
    actions: [
      ...(isNew ? [] : [{ label: 'Delete', kind: 'danger', onClick: async () => {
        const ok = await confirmDialog('Delete category?', `"${r.name}" will be removed. Transactions assigned to it will become uncategorized. Rules tied to it will also be deleted.`);
        if (!ok) return false;
        try { await q(supabase.from('transaction_categories').delete().eq('id', r.id)); toast('Deleted', { kind: 'success' }); onDone && onDone(); }
        catch (e) { toast('Failed: ' + e.message, { kind: 'error' }); return false; }
      } }]),
      { label: 'Cancel', kind: 'secondary' },
      { label: isNew ? 'Create' : 'Save', kind: 'primary', onClick: async (bg) => {
        const data = {
          name: bg.querySelector('#f-name').value.trim(),
          display_order: Number(bg.querySelector('#f-order').value || 100),
          color: bg.querySelector('#f-color').value,
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
// Rules
// =============================================================================

async function loadRules() {
  try {
    const [rules, cats] = await Promise.all([
      q(supabase.from('categorization_rules').select('*').order('priority')),
      q(supabase.from('transaction_categories').select('id, name, color').eq('is_active', true).order('display_order')),
    ]);
    const catMap = new Map(cats.map(c => [c.id, c]));
    window.__rulesAll = rules.map(r => ({
      ...r,
      _categoryName: catMap.get(r.category_id)?.name || '(deleted)',
      _categoryColor: catMap.get(r.category_id)?.color,
    }));
    window.__rulesCats = cats;
    if (!rules.length) {
      document.getElementById('rules-table-wrap').innerHTML =
        `<div class="empty-state"><div class="muted">No rules yet. Click "+ Rule" to create your first one. Examples: "Shell" → Gas & Fuel, "AMEX Epayment" → Bank Fees, "Aramark" → Office Supplies.</div></div>`;
      return;
    }
    renderRules();
  } catch (e) {
    document.getElementById('rules-table-wrap').innerHTML =
      `<div class="empty-state"><div style="color:var(--red)">${escapeHtml(e.message)}</div></div>`;
  }
}

function renderRules() {
  const rules = window.__rulesAll || [];
  const wrap = document.getElementById('rules-table-wrap');
  const state = getSortState(RULES_MOD, { key: 'priority', dir: 'asc' });
  const sorted = sortRows(rules, RULE_COLUMNS, state);
  wrap.innerHTML = `
    <table class="data">
      <thead><tr>${headerHTML(RULE_COLUMNS, state)}</tr></thead>
      <tbody>
        ${sorted.map(r => `
          <tr>
            <td><strong class="mono">"${escapeHtml(r.match_text || '')}"</strong></td>
            <td><span class="pill pill-gray">${(r.match_type || 'contains').toUpperCase().replace('_',' ')}</span></td>
            <td><span style="display:inline-block;width:8px;height:8px;background:${r._categoryColor || '#888'};border-radius:2px;margin-right:6px;vertical-align:middle"></span>${escapeHtml(r._categoryName)}</td>
            <td class="numeric">${r.priority}</td>
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
      editRule(r, () => { loadRules(); loadCats(); });
    };
  });
  attachSortHandlers(wrap, RULES_MOD, () => renderRules());
}

function editRule(record, onDone) {
  const isNew = !record;
  const r = record || { match_text: '', match_type: 'contains', category_id: null, priority: 100, is_active: true };
  const cats = window.__rulesCats || [];
  const catOpts = `<option value="">— Select category —</option>` +
    cats.map(c => `<option value="${c.id}" ${c.id === r.category_id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
  modal({
    title: isNew ? 'New Rule' : 'Edit Rule',
    bodyHTML: `
      <div class="muted" style="font-size:11px;margin-bottom:8px">When a transaction's description matches the text below, automatically assign the chosen category.</div>
      <div class="field"><label class="field-label">Match Text *</label><input class="input mono" id="f-text" value="${escapeHtml(r.match_text || '')}" placeholder="e.g. Shell, AMEX Epayment, Aramark"></div>
      <div class="field-row">
        <div class="field"><label class="field-label">Match Type</label>
          <select class="select" id="f-type">
            ${[
              ['contains','Contains (description includes this text anywhere)'],
              ['starts_with','Starts with'],
              ['exact','Exact match (whole description)'],
            ].map(([v,lbl]) => `<option value="${v}" ${v === r.match_type ? 'selected' : ''}>${lbl}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field"><label class="field-label">Assign to Category *</label><select class="select" id="f-cat">${catOpts}</select></div>
      <div class="field-row">
        <div class="field"><label class="field-label">Priority</label><input class="input numeric" id="f-prio" type="number" value="${r.priority || 100}"><div class="muted" style="font-size:10px;margin-top:2px">Lower number wins on ties (default 100)</div></div>
        <div class="field" style="display:flex;gap:8px;align-items:center;align-self:end;padding-bottom:6px">
          <input type="checkbox" id="f-active" ${r.is_active !== false ? 'checked' : ''}>
          <label for="f-active" class="field-label" style="margin:0">Active</label>
        </div>
      </div>
    `,
    actions: [
      ...(isNew ? [] : [{ label: 'Delete', kind: 'danger', onClick: async () => {
        const ok = await confirmDialog('Delete rule?', `Rule "${r.match_text}" → ${r._categoryName} will be removed. Existing transaction categorizations are not affected.`);
        if (!ok) return false;
        try { await q(supabase.from('categorization_rules').delete().eq('id', r.id)); toast('Deleted', { kind: 'success' }); onDone && onDone(); }
        catch (e) { toast('Failed: ' + e.message, { kind: 'error' }); return false; }
      } }]),
      { label: 'Cancel', kind: 'secondary' },
      { label: isNew ? 'Create' : 'Save', kind: 'primary', onClick: async (bg) => {
        const data = {
          match_text: bg.querySelector('#f-text').value.trim(),
          match_type: bg.querySelector('#f-type').value,
          category_id: bg.querySelector('#f-cat').value || null,
          priority: Number(bg.querySelector('#f-prio').value || 100),
          is_active: bg.querySelector('#f-active').checked,
        };
        if (!data.match_text) { toast('Match text is required', { kind: 'error' }); return false; }
        if (!data.category_id) { toast('Select a category', { kind: 'error' }); return false; }
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
// Chart of Accounts (existing)
// =============================================================================

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

// =============================================================================
// Tax Year Locks (existing)
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
