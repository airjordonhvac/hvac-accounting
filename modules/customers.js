// =============================================================================
// Customers — CRUD for AR contacts (GCs, owners, end clients)
// =============================================================================
import { supabase, q } from '../lib/supabase.js';
import { fmtMoney, fmtDate, escapeHtml } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { confirmDialog, modal } from '../lib/modal.js';

export async function renderCustomers(outlet) {
  outlet.innerHTML = `
    <div class="page-head">
      <div class="page-head-left">
        <h1>CUSTOMERS</h1>
        <div class="page-head-sub">GCs, owners, end clients</div>
      </div>
      <div class="page-head-right">
        <button class="btn-primary" id="new-customer">+ New Customer</button>
      </div>
    </div>
    <div class="toolbar">
      <input type="search" id="cust-search" placeholder="Search customers…" class="input" style="max-width:280px">
    </div>
    <div id="cust-table-wrap" class="table-wrap">
      <div class="empty-state"><div class="big">LOADING</div></div>
    </div>
  `;

  document.getElementById('new-customer').onclick = () => editCustomer(null, () => loadList(outlet));
  document.getElementById('cust-search').oninput = (e) => filterList(outlet, e.target.value);

  await loadList(outlet);
}

async function loadList(outlet) {
  const wrap = document.getElementById('cust-table-wrap');
  try {
    const data = await q(supabase.from('customers').select('*').order('name'));
    // Pull AR balances per customer
    const ar = await q(supabase.from('invoices').select('customer_id, total, amount_paid, status'));
    const arByCust = new Map();
    for (const r of ar) {
      if (r.status === 'void') continue;
      const open = Number(r.total) - Number(r.amount_paid);
      arByCust.set(r.customer_id, (arByCust.get(r.customer_id) || 0) + open);
    }
    window.__custAll = data.map(c => ({ ...c, _ar: arByCust.get(c.id) || 0 }));
    renderTable(window.__custAll);
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state"><div class="big" style="color:var(--red)">ERROR</div><div>${escapeHtml(e.message)}</div></div>`;
  }
}

function filterList(outlet, term) {
  const all = window.__custAll || [];
  const t = term.trim().toLowerCase();
  const filtered = !t ? all : all.filter(c =>
    (c.name || '').toLowerCase().includes(t) ||
    (c.company || '').toLowerCase().includes(t) ||
    (c.email || '').toLowerCase().includes(t)
  );
  renderTable(filtered);
}

function renderTable(rows) {
  const wrap = document.getElementById('cust-table-wrap');
  if (!rows.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="big">NO CUSTOMERS</div><div>Click "New Customer" to add one.</div></div>`;
    return;
  }
  wrap.innerHTML = `
    <table class="data">
      <thead>
        <tr>
          <th>Name</th>
          <th>Company</th>
          <th>Email</th>
          <th>Phone</th>
          <th>Terms</th>
          <th class="numeric">Open AR</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(c => `
          <tr data-id="${c.id}" class="clickable">
            <td><strong>${escapeHtml(c.name)}</strong></td>
            <td>${escapeHtml(c.company || '')}</td>
            <td>${escapeHtml(c.email || '')}</td>
            <td>${escapeHtml(c.phone || '')}</td>
            <td>${escapeHtml((c.payment_terms || 'net_30').replace('_', ' ').toUpperCase())}</td>
            <td class="numeric">${c._ar > 0 ? fmtMoney(c._ar) : '<span class="muted">—</span>'}</td>
            <td><button class="btn-sm btn-ghost edit-btn" data-id="${c.id}">Edit</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  wrap.querySelectorAll('.edit-btn').forEach(b => {
    b.onclick = (e) => {
      e.stopPropagation();
      const id = b.dataset.id;
      const c = (window.__custAll || []).find(x => x.id === id);
      editCustomer(c, () => loadList());
    };
  });
}

function editCustomer(record, onDone) {
  const isNew = !record;
  const r = record || { name: '', company: '', email: '', phone: '', billing_address: '', payment_terms: 'net_30', tax_exempt: false, notes: '' };

  modal({
    title: isNew ? 'New Customer' : 'Edit Customer',
    bodyHTML: `
      <div class="field"><label class="field-label">Name *</label><input class="input" id="f-name" value="${escapeHtml(r.name || '')}"></div>
      <div class="field-row">
        <div class="field"><label class="field-label">Company</label><input class="input" id="f-company" value="${escapeHtml(r.company || '')}"></div>
        <div class="field"><label class="field-label">Payment Terms</label>
          <select class="select" id="f-terms">
            ${['cod','net_15','net_30','net_45','net_60','net_90'].map(t => `<option value="${t}" ${t === (r.payment_terms || 'net_30') ? 'selected' : ''}>${t.toUpperCase().replace('_',' ')}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label class="field-label">Email</label><input class="input" id="f-email" type="email" value="${escapeHtml(r.email || '')}"></div>
        <div class="field"><label class="field-label">Phone</label><input class="input" id="f-phone" value="${escapeHtml(r.phone || '')}"></div>
      </div>
      <div class="field"><label class="field-label">Billing Address</label><textarea class="input" id="f-addr" rows="2">${escapeHtml(r.billing_address || '')}</textarea></div>
      <div class="field"><label class="field-label">Notes</label><textarea class="input" id="f-notes" rows="2">${escapeHtml(r.notes || '')}</textarea></div>
    `,
    actions: [
      ...(isNew ? [] : [{ label: 'Delete', kind: 'danger', onClick: async (bg) => {
        const ok = await confirmDialog('Delete customer?', `${r.name} will be removed. Invoices stay but lose the link.`);
        if (!ok) return false;
        try {
          await q(supabase.from('customers').delete().eq('id', r.id));
          toast('Deleted', { kind: 'success' });
          onDone && onDone();
        } catch (e) {
          toast('Could not delete: ' + e.message, { kind: 'error' });
          return false;
        }
      } }]),
      { label: 'Cancel', kind: 'secondary' },
      { label: isNew ? 'Create' : 'Save', kind: 'primary', onClick: async (bg) => {
        const data = {
          name: bg.querySelector('#f-name').value.trim(),
          company: bg.querySelector('#f-company').value.trim() || null,
          email: bg.querySelector('#f-email').value.trim() || null,
          phone: bg.querySelector('#f-phone').value.trim() || null,
          billing_address: bg.querySelector('#f-addr').value.trim() || null,
          payment_terms: bg.querySelector('#f-terms').value,
          notes: bg.querySelector('#f-notes').value.trim() || null,
        };
        if (!data.name) { toast('Name is required', { kind: 'error' }); return false; }
        try {
          if (isNew) await q(supabase.from('customers').insert(data));
          else await q(supabase.from('customers').update(data).eq('id', r.id));
          toast('Saved', { kind: 'success' });
          onDone && onDone();
        } catch (e) {
          toast('Save failed: ' + e.message, { kind: 'error' });
          return false;
        }
      } },
    ],
  });
}
