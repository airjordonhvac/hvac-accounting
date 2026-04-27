// =============================================================================
// Vendors — CRUD for AP contacts (subs, suppliers, utilities) with 1099 + COI
// =============================================================================
import { supabase, q } from '../lib/supabase.js';
import { fmtMoney, fmtDate, escapeHtml } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { confirmDialog, modal } from '../lib/modal.js';
import { sortRows, headerHTML, attachSortHandlers, getSortState } from '../lib/sort.js';

const MOD = 'vendors';

// Returns { state: 'ok' | 'expiring' | 'expired' | 'missing', daysLeft: number | null }
function coiStatus(v) {
  if (!v.coi_url) return { state: 'missing', daysLeft: null };
  if (!v.coi_expiry_date) return { state: 'ok', daysLeft: null };
  const today = new Date();
  today.setHours(0,0,0,0);
  const exp = new Date(v.coi_expiry_date);
  exp.setHours(0,0,0,0);
  const days = Math.round((exp - today) / 86400000);
  if (days < 0) return { state: 'expired', daysLeft: days };
  if (days <= 30) return { state: 'expiring', daysLeft: days };
  return { state: 'ok', daysLeft: days };
}

// COI sort weight: missing < expired < expiring < ok (but on natural-sort think:
// urgent items should appear first in 'asc'. Let's use numbers: 0 = most urgent)
function coiSortKey(v) {
  const s = coiStatus(v);
  if (s.state === 'missing') return 0;
  if (s.state === 'expired') return 1;
  if (s.state === 'expiring') return 2;
  return 3;
}

const COLUMNS = [
  { key: 'name',           label: 'Name',     type: 'string' },
  { key: 'contact',        label: 'Contact',  type: 'string' },
  { key: 'email',          label: 'Email',    type: 'string' },
  { key: 'phone',          label: 'Phone',    type: 'string' },
  { key: 'is_1099',        label: '1099',     type: 'number', get: r => r.is_1099 ? 1 : 0 },
  { key: 'w9_url',         label: 'W-9',      type: 'number', get: r => r.w9_url ? 1 : 0 },
  { key: 'coi_status',     label: 'COI',      type: 'number', get: r => coiSortKey(r) },
  { key: '_ap',            label: 'Open AP',  type: 'number', numeric: true },
  { key: '_actions',       label: '',         sortable: false },
];

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
      <label class="muted" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="ven-coi-issues">COI issues only</label>
    </div>
    <div id="ven-table-wrap" class="table-wrap">
      <div class="empty-state"><div class="big">LOADING</div></div>
    </div>
  `;
  document.getElementById('new-vendor').onclick = () => editVendor(null, [], () => loadList());
  document.getElementById('ven-search').oninput = () => filterAndRender();
  document.getElementById('ven-1099').onchange = () => filterAndRender();
  document.getElementById('ven-coi-issues').onchange = () => filterAndRender();
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

function coiPill(v) {
  const s = coiStatus(v);
  if (s.state === 'missing') return '<span class="pill" style="background:rgba(226,92,92,.18);color:var(--red)">NONE</span>';
  if (s.state === 'expired') return `<span class="pill pill-red">EXPIRED ${Math.abs(s.daysLeft)}d</span>`;
  if (s.state === 'expiring') return `<span class="pill pill-amber">${s.daysLeft}d LEFT</span>`;
  return s.daysLeft != null
    ? `<span class="pill pill-green">VALID</span>`
    : '<span class="pill pill-green">ON FILE</span>';
}

function filterAndRender() {
  const all = window.__venAll || [];
  const term = (document.getElementById('ven-search')?.value || '').trim().toLowerCase();
  const only1099 = document.getElementById('ven-1099')?.checked;
  const onlyCoi = document.getElementById('ven-coi-issues')?.checked;
  let rows = all;
  if (term) rows = rows.filter(v =>
    (v.name || '').toLowerCase().includes(term) ||
    (v.email || '').toLowerCase().includes(term) ||
    (v.contact || '').toLowerCase().includes(term));
  if (only1099) rows = rows.filter(v => v.is_1099);
  if (onlyCoi) rows = rows.filter(v => {
    const s = coiStatus(v).state;
    return s === 'missing' || s === 'expired' || s === 'expiring';
  });
  renderTable(rows);
}

function renderTable(rows) {
  const wrap = document.getElementById('ven-table-wrap');
  if (!rows.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="big">NO VENDORS</div><div>Click "New Vendor" to add one.</div></div>`;
    return;
  }
  const state = getSortState(MOD, { key: 'name', dir: 'asc' });
  const sorted = sortRows(rows, COLUMNS, state);
  wrap.innerHTML = `
    <table class="data">
      <thead><tr>${headerHTML(COLUMNS, state)}</tr></thead>
      <tbody>
        ${sorted.map(v => `
          <tr>
            <td><strong>${escapeHtml(v.name)}</strong></td>
            <td>${escapeHtml(v.contact || '')}</td>
            <td>${escapeHtml(v.email || '')}</td>
            <td>${escapeHtml(v.phone || '')}</td>
            <td>${v.is_1099 ? '<span class="pill pill-gold">1099</span>' : '<span class="muted">—</span>'}</td>
            <td>${v.w9_url ? `<a href="#" class="w9-link" data-path="${escapeHtml(v.w9_url)}">View</a>` : '<span class="muted">—</span>'}</td>
            <td>
              ${coiPill(v)}
              ${v.coi_url ? `<div style="margin-top:2px"><a href="#" class="coi-link" data-path="${escapeHtml(v.coi_url)}" style="font-size:11px">View</a>${v.coi_expiry_date ? ` <span class="muted" style="font-size:11px">exp ${fmtDate(v.coi_expiry_date)}</span>` : ''}</div>` : ''}
            </td>
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
  wrap.querySelectorAll('.coi-link').forEach(a => {
    a.onclick = async (e) => {
      e.preventDefault();
      try {
        const { data, error } = await supabase.storage.from('coi-documents').createSignedUrl(a.dataset.path, 600);
        if (error) throw error;
        window.open(data.signedUrl, '_blank');
      } catch (err) { toast('Could not open COI: ' + err.message, { kind: 'error' }); }
    };
  });
  attachSortHandlers(wrap, MOD, () => renderTable(rows));
}

function editVendor(record, accounts, onDone) {
  const isNew = !record;
  const r = record || {
    name: '', contact: '', email: '', phone: '', address: '',
    is_1099: false, payment_method: 'check', notes: '',
    default_expense_account: null,
    coi_url: null, coi_expiry_date: null, coi_received_date: null,
  };
  const accOpts = accounts.map(a =>
    `<option value="${a.id}" ${a.id === r.default_expense_account ? 'selected' : ''}>${escapeHtml(a.account_number)} — ${escapeHtml(a.name)}</option>`
  ).join('');
  const coiState = coiStatus(r);
  const coiBadge = r.coi_url
    ? (coiState.state === 'expired'
        ? `<span class="pill pill-red" style="margin-left:8px">EXPIRED ${Math.abs(coiState.daysLeft)}d ago</span>`
        : coiState.state === 'expiring'
          ? `<span class="pill pill-amber" style="margin-left:8px">${coiState.daysLeft}d left</span>`
          : `<span class="pill pill-green" style="margin-left:8px">VALID</span>`)
    : '';
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

      <div style="border-top:1px solid var(--hairline);margin:14px 0 0;padding-top:14px">
        <div class="section-title" style="margin-bottom:10px">CERTIFICATE OF INSURANCE (COI)${coiBadge}</div>
        ${r.coi_url ? `
          <div class="muted" style="margin-bottom:8px">
            Current file on record. <a href="#" id="coi-current-view">View</a>
            <button class="btn-sm btn-ghost" id="coi-clear" type="button" style="margin-left:8px">Remove</button>
          </div>
        ` : ''}
        <div class="field">
          <label class="field-label">${r.coi_url ? 'Replace with new file' : 'Upload COI'} (PDF or image, max 10MB)</label>
          <input class="input" id="f-coi-file" type="file" accept="application/pdf,image/*">
        </div>
        <div class="field-row">
          <div class="field"><label class="field-label">COI Received Date</label><input class="input" id="f-coi-recv" type="date" value="${r.coi_received_date || ''}"></div>
          <div class="field"><label class="field-label">COI Expiry Date</label><input class="input" id="f-coi-exp" type="date" value="${r.coi_expiry_date || ''}"></div>
        </div>
      </div>

      <div class="field" style="margin-top:14px"><label class="field-label">Notes</label><textarea class="input" id="f-notes" rows="2">${escapeHtml(r.notes || '')}</textarea></div>
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
          coi_received_date: bg.querySelector('#f-coi-recv').value || null,
          coi_expiry_date: bg.querySelector('#f-coi-exp').value || null,
        };
        if (!data.name) { toast('Name is required', { kind: 'error' }); return false; }

        const fileInput = bg.querySelector('#f-coi-file');
        const file = fileInput?.files?.[0];
        const cleared = bg.dataset.coiCleared === '1';

        try {
          let vendorId = r.id;
          if (isNew) {
            const ins = await q(supabase.from('vendors').insert({ ...data, coi_url: null }).select().single());
            vendorId = ins.id;
          } else {
            await q(supabase.from('vendors').update(data).eq('id', r.id));
          }

          if (file) {
            if (file.size > 10485760) { toast('File too large (max 10MB)', { kind: 'error' }); return false; }
            const ext = (file.name.split('.').pop() || 'pdf').toLowerCase();
            const path = `${vendorId}/coi-${Date.now()}.${ext}`;
            const { error: upErr } = await supabase.storage.from('coi-documents').upload(path, file, { upsert: false });
            if (upErr) throw new Error('Upload failed: ' + upErr.message);
            if (r.coi_url) {
              await supabase.storage.from('coi-documents').remove([r.coi_url]).catch(() => {});
            }
            await q(supabase.from('vendors').update({ coi_url: path }).eq('id', vendorId));
          } else if (cleared && r.coi_url) {
            await supabase.storage.from('coi-documents').remove([r.coi_url]).catch(() => {});
            await q(supabase.from('vendors').update({ coi_url: null, coi_expiry_date: null, coi_received_date: null }).eq('id', vendorId));
          }

          toast('Saved', { kind: 'success' });
          onDone && onDone();
        } catch (e) {
          toast('Save failed: ' + e.message, { kind: 'error' });
          return false;
        }
      } },
    ],
  });

  setTimeout(() => {
    const bg = document.querySelector('.modal');
    if (!bg) return;
    const viewBtn = bg.querySelector('#coi-current-view');
    if (viewBtn) {
      viewBtn.onclick = async (e) => {
        e.preventDefault();
        try {
          const { data, error } = await supabase.storage.from('coi-documents').createSignedUrl(r.coi_url, 600);
          if (error) throw error;
          window.open(data.signedUrl, '_blank');
        } catch (err) { toast('Could not open COI: ' + err.message, { kind: 'error' }); }
      };
    }
    const clearBtn = bg.querySelector('#coi-clear');
    if (clearBtn) {
      clearBtn.onclick = (e) => {
        e.preventDefault();
        bg.dataset.coiCleared = '1';
        const note = document.createElement('div');
        note.className = 'muted';
        note.style.cssText = 'color:var(--red);font-size:11px;margin-top:4px';
        note.textContent = 'COI will be removed when you click Save';
        clearBtn.closest('div').appendChild(note);
        clearBtn.disabled = true;
        clearBtn.textContent = 'Will remove';
      };
    }
  }, 50);
}
