// =============================================================================
// Vendors — CRUD for AP contacts (subs, suppliers, utilities) with 1099 fields
// =============================================================================
import { supabase, q } from '../lib/supabase.js';
import { fmtMoney, escapeHtml } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { confirmDialog, modal } from '../lib/modal.js';

export async function renderVendors(outlet) {
  outlet.innerHTML = `
    <div class="page-head">
      <div class="page-head-left">
        <h1>VENDORS</h1>
        <div class="page-head-sub">Suppliers, subs, utilities</div>
      </div>
      <div class="page-head-right">
        <button class="btn-primary" id="new-vendor">+ New Vendor</button>
      </div>
    </div>
    <div class="toolbar">
      <input type="search" id="ven-search" placeholder="Search vendors…" class="input" style="max-width:280px">
      <label class="muted" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="ven-1099">1099 only</label>
    </div>
    <div id="ven-table-wrap" class="table-wrap">
      <div class="empty-state"><div class="big">LOADING</div></div>
    </div>
  `;
  document.getElementById('new-vendor').onclick = () => editVendor(null, [], () => loadList());
  document.getElementById('ven-search').oninput = () => filterAndRender();
  document.getElementById('ven-1099').onchange = () => filterAndRender();
  await loadList();
}

async function loadList() {
  const wrap = document.getElementById('ven-table-wrap');
  try {
    const [vendors, accounts, ap] = await Promise.all([
      q(supabase.from('vendors').select('*').order('name')),
      q(supabase.from('chart_of_accounts').select('id, account_number, name').eq('is_active', true).order('account_number')),
      q(supabase.from('bills').select('vendor_id, total, amount_paid, status')),
    ]);
    const apByVen = new Map();
    for (const r of ap) {
      if (r.status === 'void') continue;
      const open = Number(r.total) - Number(r.amount_paid);
      apByVen.set(r.vendor_id, (apByVen.get(r.vendor_id) || 0) + open);
    }
    window.__venAll = vendors.map(v => ({ ...v, _ap: apByVen.get(v.id) || 0 }));
    window.__venCoa = accounts;
    filterAndRender();
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state"><div class="big" style="color:var(--red)">ERROR</div><div>${escapeHtml(e.message)}</div></div>`;
  }
}

function filterAndRender() {
  const all = window.__venAll || [];
  const term = (document.getElementById('ven-search')?.value || '').trim().toLowerCase();
  const only1099 = document.getElementById('ven-1099')?.checked;
  let rows = all;
  if (term) rows = rows.filter(v =>
    (v.name || '').toLowerCase().includes(term) ||
    (v.email || '').toLowerCase().includes(term) ||
    (v.contact || '').toLowerCase().includes(term));
  if (only1099) rows = rows.filter(v => v.is_1099);
  renderTable(rows);
}

function renderTable(rows) {
  const wrap = document.getElementById('ven-table-wrap');
  if (!rows.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="big">NO VENDORS</div><div>Click "New Vendor" to add one.</div></div>`;
    return;
  }
  wrap.innerHTML = `
    <table class="data">
      <thead><tr>
        <th>Name</th><th>Contact</th><th>Email / Phone</th><th>1099</th><th>W-9</th><th class="numeric">Open AP</th><th></th>
      </tr></thead>
      <tbody>
        ${rows.map(v => `
          <tr>
            <td><strong>${escapeHtml(v.name)}</strong></td>
            <td>${escapeHtml(v.contact || '')}</td>
            <td>
              ${v.email ? `<div>${escapeHtml(v.email)}</div>` : ''}
              ${v.phone ? `<div class="muted">${escapeHtml(v.phone)}</div>` : ''}
            </td>
            <td>${v.is_1099 ? '<span class="pill pill-gold">1099</span>' : '<span class="muted">—</span>'}</td>
            <td>${v.w9_url ? `<a href="#" class="w9-link" data-path="${escapeHtml(v.w9_url)}">View</a>` : '<span class="muted">—</span>'}</td>
            <td class="numeric">${v._ap > 0 ? fmtMoney(v._ap) : '<span class="muted">—</span>'}</td>
            <td><button class="btn-sm btn-ghost edit-btn" data-id="${v.id}">Edit</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  wrap.querySelectorAll('.edit-btn').forEach(b => {
    b.onclick = () => {
      const v = (window.__venAll || []).find(x => x.id === b.dataset.id);
      editVendor(v, window.__venCoa || [], () => loadList());
    };
  });
  wrap.querySelectorAll('.w9-link').forEach(a => {
    a.onclick = async (e) => {
      e.preventDefault();
      try {
        const { data, error } = await supabase.storage.from('w9-documents').createSignedUrl(a.dataset.path, 600);
        if (error) throw error;
        window.open(data.signedUrl, '_blank');
      } catch (err) { toast('Could not open W-9: ' + err.message, { kind: 'error' }); }
    };
  });
}

function editVendor(record, accounts, onDone) {
  const isNew = !record;
  const r = record || { name: '', contact: '', email: '', phone: '', address: '', is_1099: false, payment_method: 'check', notes: '', default_expense_account: null };
  const accOpts = accounts.map(a =>
    `<option value="${a.id}" ${a.id === r.default_expense_account ? 'selected' : ''}>${escapeHtml(a.account_number)} — ${escapeHtml(a.name)}</option>`
  ).join('');
  modal({
    title: isNew ? 'New Vendor' : 'Edit Vendor',
    bodyHTML: `
      <div class="field"><label class="field-label">Name *</label><input class="input" id="f-name" value="${escapeHtml(r.name || '')}"></div>
      <div class="field-row">
        <div class="field"><label class="field-label">Contact Person</label><input class="input" id="f-contact" value="${escapeHtml(r.contact || '')}"></div>
        <div class="field"><label class="field-label">Payment Method</label>
          <select class="select" id="f-method">
            ${['check','ach','card','cash','wire'].map(m => `<option value="${m}" ${m === (r.payment_method || 'check') ? 'selected' : ''}>${m.toUpperCase()}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label class="field-label">Email</label><input class="input" id="f-email" type="email" value="${escapeHtml(r.email || '')}"></div>
        <div class="field"><label class="field-label">Phone</label><input class="input" id="f-phone" value="${escapeHtml(r.phone || '')}"></div>
      </div>
      <div class="field"><label class="field-label">Address</label><textarea class="input" id="f-addr" rows="2">${escapeHtml(r.address || '')}</textarea></div>
      <div class="field"><label class="field-label">Default Expense Account</label>
        <select class="select" id="f-acct"><option value="">— None —</option>${accOpts}</select>
      </div>
      <div class="field" style="display:flex;gap:8px;align-items:center">
        <input type="checkbox" id="f-1099" ${r.is_1099 ? 'checked' : ''}>
        <label for="f-1099" class="field-label" style="margin:0">1099 Vendor (subcontractor)</label>
      </div>
      <div class="field"><label class="field-label">Notes</label><textarea class="input" id="f-notes" rows="2">${escapeHtml(r.notes || '')}</textarea></div>
    `,
    actions: [
      ...(isNew ? [] : [{ label: 'Delete', kind: 'danger', onClick: async () => {
        const ok = await confirmDialog('Delete vendor?', `${r.name} will be removed. Bills stay but lose the link.`);
        if (!ok) return false;
        try {
          await q(supabase.from('vendors').delete().eq('id', r.id));
          toast('Deleted', { kind: 'success' });
          onDone && onDone();
        } catch (e) { toast('Could not delete: ' + e.message, { kind: 'error' }); return false; }
      } }]),
      { label: 'Cancel', kind: 'secondary' },
      { label: isNew ? 'Create' : 'Save', kind: 'primary', onClick: async (bg) => {
        const data = {
          name: bg.querySelector('#f-name').value.trim(),
          contact: bg.querySelector('#f-contact').value.trim() || null,
          email: bg.querySelector('#f-email').value.trim() || null,
          phone: bg.querySelector('#f-phone').value.trim() || null,
          address: bg.querySelector('#f-addr').value.trim() || null,
          payment_method: bg.querySelector('#f-method').value,
          default_expense_account: bg.querySelector('#f-acct').value || null,
          is_1099: bg.querySelector('#f-1099').checked,
          notes: bg.querySelector('#f-notes').value.trim() || null,
        };
        if (!data.name) { toast('Name is required', { kind: 'error' }); return false; }
        try {
          if (isNew) await q(supabase.from('vendors').insert(data));
          else await q(supabase.from('vendors').update(data).eq('id', r.id));
          toast('Saved', { kind: 'success' });
          onDone && onDone();
        } catch (e) { toast('Save failed: ' + e.message, { kind: 'error' }); return false; }
      } },
    ],
  });
}
