// =============================================================================
// Projects — CRUD with contract value, dates, status, AR/AP rollups
// =============================================================================
import { supabase, q } from '../lib/supabase.js';
import { fmtMoney, escapeHtml } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { confirmDialog, modal } from '../lib/modal.js';
import { sortRows, headerHTML, attachSortHandlers, getSortState } from '../lib/sort.js';

const MOD = 'projects';

const COLUMNS = [
  { key: 'project_number',  label: '#',         type: 'string' },
  { key: 'name',            label: 'Name',      type: 'string' },
  { key: 'customer_name',   label: 'Customer',  type: 'string', get: r => r._customer?.name || '' },
  { key: 'status',          label: 'Status',    type: 'string' },
  { key: 'contract_amount', label: 'Contract',  type: 'number', numeric: true },
  { key: '_invoiced',       label: 'Invoiced',  type: 'number', numeric: true },
  { key: '_cost',           label: 'Cost',      type: 'number', numeric: true },
  { key: '_margin',         label: 'Margin',    type: 'number', numeric: true, get: r => r._invoiced - r._cost },
  { key: '_actions',        label: '',          sortable: false },
];

export async function renderProjects(outlet) {
  outlet.innerHTML = `
    <div class="page-head">
      <div class="page-head-left">
        <h1>PROJECTS</h1>
        <div class="page-head-sub">Jobs for job costing</div>
      </div>
      <div class="page-head-right">
        <button class="btn-primary" id="new-proj">+ New Project</button>
      </div>
    </div>
    <div class="toolbar">
      <input type="search" id="proj-search" placeholder="Search projects…" class="input" style="max-width:280px">
      <select id="proj-status" class="select" style="max-width:160px">
        <option value="">All statuses</option>
        <option value="bidding">Bidding</option>
        <option value="active">Active</option>
        <option value="closed">Closed</option>
        <option value="cancelled">Cancelled</option>
      </select>
    </div>
    <div id="proj-table-wrap" class="table-wrap">
      <div class="empty-state"><div class="big">LOADING</div></div>
    </div>
  `;

  document.getElementById('new-proj').onclick = () => editProject(null, [], () => loadList());
  document.getElementById('proj-search').oninput = () => filterAndRender();
  document.getElementById('proj-status').onchange = () => filterAndRender();

  await loadList();
}

async function loadList() {
  const wrap = document.getElementById('proj-table-wrap');
  try {
    const [projects, customers, invoices, bills] = await Promise.all([
      q(supabase.from('projects').select('*').order('project_number', { ascending: false })),
      q(supabase.from('customers').select('id, name, company')),
      q(supabase.from('invoices').select('project_id, total, amount_paid, status')),
      q(supabase.from('bills').select('project_id, total, amount_paid, status')),
    ]);
    const custMap = new Map(customers.map(c => [c.id, c]));
    const invByProj = new Map();
    for (const r of invoices) {
      if (r.status === 'void') continue;
      const cur = invByProj.get(r.project_id) || { invoiced: 0, collected: 0 };
      cur.invoiced += Number(r.total);
      cur.collected += Number(r.amount_paid);
      invByProj.set(r.project_id, cur);
    }
    const billByProj = new Map();
    for (const r of bills) {
      if (r.status === 'void') continue;
      const cur = billByProj.get(r.project_id) || { cost: 0 };
      cur.cost += Number(r.total);
      billByProj.set(r.project_id, cur);
    }
    window.__projAll = projects.map(p => ({
      ...p,
      _customer: custMap.get(p.customer_id) || null,
      _invoiced: invByProj.get(p.id)?.invoiced || 0,
      _collected: invByProj.get(p.id)?.collected || 0,
      _cost: billByProj.get(p.id)?.cost || 0,
    }));
    window.__projCustomers = customers;
    filterAndRender();
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state"><div class="big" style="color:var(--red)">ERROR</div><div>${escapeHtml(e.message)}</div></div>`;
  }
}

function filterAndRender() {
  const all = window.__projAll || [];
  const term = (document.getElementById('proj-search')?.value || '').trim().toLowerCase();
  const status = document.getElementById('proj-status')?.value || '';
  let rows = all;
  if (term) rows = rows.filter(p =>
    (p.name || '').toLowerCase().includes(term) ||
    (p.project_number || '').toLowerCase().includes(term) ||
    (p._customer?.name || '').toLowerCase().includes(term));
  if (status) rows = rows.filter(p => p.status === status);
  renderTable(rows);
}

function statusPill(s) {
  const map = { bidding: 'pill-amber', active: 'pill-green', closed: 'pill-gray', cancelled: 'pill-red' };
  return `<span class="pill ${map[s] || 'pill-gray'}">${(s || 'unknown').toUpperCase()}</span>`;
}

function renderTable(rows) {
  const wrap = document.getElementById('proj-table-wrap');
  if (!rows.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="big">NO PROJECTS</div><div>Click "New Project" to add one.</div></div>`;
    return;
  }
  const state = getSortState(MOD, { key: 'project_number', dir: 'desc' });
  const sorted = sortRows(rows, COLUMNS, state);
  wrap.innerHTML = `
    <table class="data">
      <thead><tr>${headerHTML(COLUMNS, state)}</tr></thead>
      <tbody>
        ${sorted.map(p => {
          const margin = p._invoiced - p._cost;
          const marginPct = p._invoiced > 0 ? (margin / p._invoiced * 100) : 0;
          return `
          <tr>
            <td class="mono">${escapeHtml(p.project_number || '')}</td>
            <td><strong>${escapeHtml(p.name)}</strong>${p.address ? `<div class="muted">${escapeHtml(p.address)}</div>` : ''}</td>
            <td>${escapeHtml(p._customer?.name || '—')}</td>
            <td>${statusPill(p.status)}</td>
            <td class="numeric">${fmtMoney(p.contract_amount || 0)}</td>
            <td class="numeric">${fmtMoney(p._invoiced)}</td>
            <td class="numeric">${fmtMoney(p._cost)}</td>
            <td class="numeric ${margin >= 0 ? 'delta-up' : 'delta-down'}">${fmtMoney(margin)}<div class="muted" style="font-size:11px">${marginPct.toFixed(1)}%</div></td>
            <td><button class="btn-sm btn-ghost edit-btn" data-id="${p.id}">Edit</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
  wrap.querySelectorAll('.edit-btn').forEach(b => {
    b.onclick = () => {
      const p = (window.__projAll || []).find(x => x.id === b.dataset.id);
      editProject(p, window.__projCustomers || [], () => loadList());
    };
  });
  attachSortHandlers(wrap, MOD, () => renderTable(rows));
}

function editProject(record, customers, onDone) {
  const isNew = !record;
  const r = record || {
    project_number: '', name: '', customer_id: null, address: '',
    contract_amount: 0, status: 'bidding', start_date: '', estimated_end: '', notes: '',
  };
  const custOpts = `<option value="">— Select customer —</option>` + customers.map(c =>
    `<option value="${c.id}" ${c.id === r.customer_id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
  ).join('');
  modal({
    title: isNew ? 'New Project' : `Edit ${r.project_number || 'Project'}`,
    bodyHTML: `
      <div class="field-row">
        <div class="field"><label class="field-label">Project # ${isNew ? '(auto if blank)' : ''}</label><input class="input mono" id="f-num" value="${escapeHtml(r.project_number || '')}" placeholder="${new Date().getFullYear()}-001"></div>
        <div class="field"><label class="field-label">Status</label>
          <select class="select" id="f-status">
            ${['bidding','active','closed','cancelled'].map(s => `<option value="${s}" ${s === (r.status || 'bidding') ? 'selected' : ''}>${s.toUpperCase()}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field"><label class="field-label">Project Name *</label><input class="input" id="f-name" value="${escapeHtml(r.name || '')}"></div>
      <div class="field"><label class="field-label">Customer *</label><select class="select" id="f-cust">${custOpts}</select></div>
      <div class="field"><label class="field-label">Address</label><textarea class="input" id="f-addr" rows="2">${escapeHtml(r.address || '')}</textarea></div>
      <div class="field-row">
        <div class="field"><label class="field-label">Contract Amount</label><input class="input numeric" id="f-amt" type="number" step="0.01" value="${r.contract_amount || 0}"></div>
        <div class="field"><label class="field-label">Start Date</label><input class="input" id="f-start" type="date" value="${r.start_date || ''}"></div>
        <div class="field"><label class="field-label">Estimated End</label><input class="input" id="f-end" type="date" value="${r.estimated_end || ''}"></div>
      </div>
      <div class="field"><label class="field-label">Notes</label><textarea class="input" id="f-notes" rows="3">${escapeHtml(r.notes || '')}</textarea></div>
    `,
    actions: [
      ...(isNew ? [] : [{ label: 'Delete', kind: 'danger', onClick: async () => {
        const ok = await confirmDialog('Delete project?', `${r.project_number || r.name} will be removed. Bills/invoices stay but lose the link.`);
        if (!ok) return false;
        try {
          await q(supabase.from('projects').delete().eq('id', r.id));
          toast('Deleted', { kind: 'success' });
          onDone && onDone();
        } catch (e) { toast('Could not delete: ' + e.message, { kind: 'error' }); return false; }
      } }]),
      { label: 'Cancel', kind: 'secondary' },
      { label: isNew ? 'Create' : 'Save', kind: 'primary', onClick: async (bg) => {
        let projectNumber = bg.querySelector('#f-num').value.trim();
        if (isNew && !projectNumber) projectNumber = await nextProjectNumber();
        const data = {
          project_number: projectNumber,
          name: bg.querySelector('#f-name').value.trim(),
          customer_id: bg.querySelector('#f-cust').value || null,
          address: bg.querySelector('#f-addr').value.trim() || null,
          contract_amount: Number(bg.querySelector('#f-amt').value || 0),
          status: bg.querySelector('#f-status').value,
          start_date: bg.querySelector('#f-start').value || null,
          estimated_end: bg.querySelector('#f-end').value || null,
          notes: bg.querySelector('#f-notes').value.trim() || null,
        };
        if (!data.name) { toast('Name is required', { kind: 'error' }); return false; }
        if (!data.customer_id) { toast('Select a customer', { kind: 'error' }); return false; }
        try {
          if (isNew) await q(supabase.from('projects').insert(data));
          else await q(supabase.from('projects').update(data).eq('id', r.id));
          toast('Saved', { kind: 'success' });
          onDone && onDone();
        } catch (e) { toast('Save failed: ' + e.message, { kind: 'error' }); return false; }
      } },
    ],
  });
}

async function nextProjectNumber() {
  const year = new Date().getFullYear();
  try {
    const data = await q(supabase.from('projects').select('project_number').like('project_number', `${year}-%`).order('project_number', { ascending: false }).limit(1));
    if (!data.length) return `${year}-001`;
    const last = parseInt(data[0].project_number.split('-')[1] || '0', 10);
    return `${year}-${String(last + 1).padStart(3, '0')}`;
  } catch { return `${year}-001`; }
}
