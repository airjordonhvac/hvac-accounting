// =============================================================================
// Vendors — list, edit, merge duplicates, COI/W-9 tracking
// =============================================================================
import { supabase, q } from '../lib/supabase.js';
import { fmtMoney, fmtDate, escapeHtml } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { confirmDialog, modal } from '../lib/modal.js';
import { sortRows, headerHTML, attachSortHandlers, getSortState } from '../lib/sort.js';

const MOD = 'vendors';

// Normalize a vendor name for fuzzy duplicate detection.
// Strips common business suffixes (INC, LLC, CORP, CO, LP, LTD), punctuation,
// extra whitespace, and lowercases. Two vendors with the same normalized name
// are flagged as possible duplicates.
function normalizeForDupe(name) {
  if (!name) return '';
  let s = name.toLowerCase().trim();
  s = s.replace(/[.,&/\\()'"\-]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(/\b(inc|llc|corp|corporation|co|company|lp|ltd|limited|incorporated|services|service|enterprises|holdings|group)\b/g, '').trim();
    s = s.replace(/\s+/g, ' ').trim();
    if (s === before) break;
  }
  return s;
}

function coiStatus(v) {
  if (!v.coi_url) return 'NONE';
  if (!v.coi_expiry_date) return 'ON FILE';
  const today = new Date().toISOString().slice(0, 10);
  return v.coi_expiry_date < today ? 'EXPIRED' : 'ON FILE';
}

function coiSortKey(v) {
  const s = coiStatus(v);
  if (s === 'EXPIRED') return 0;
  if (s === 'NONE') return 1;
  return 2;
}

function coiPill(v) {
  const s = coiStatus(v);
  const cls = s === 'EXPIRED' ? 'pill-red' : s === 'NONE' ? 'pill-amber' : 'pill-green';
  let html = `<span class="pill ${cls}">${s}</span>`;
  if (v.coi_url) html += `<div><a href="${escapeHtml(v.coi_url)}" target="_blank" style="font-size:11px">View</a></div>`;
  return html;
}

const COLUMNS = [
  { key: 'name',        label: 'Name',       type: 'string' },
  { key: 'contact',     label: 'Contact',    type: 'string' },
  { key: 'email',       label: 'Email',      type: 'string' },
  { key: 'phone',       label: 'Phone',      type: 'string' },
  { key: 'is_1099',     label: '1099',       type: 'number', get: r => r.is_1099 ? 1 : 0 },
  { key: 'w9',          label: 'W-9',        type: 'number', get: r => r.w9_url ? 1 : 0 },
  { key: 'coi',         label: 'COI',        type: 'number', get: r => coiSortKey(r) },
  { key: 'open_ap',     label: 'Open AP',    type: 'number', get: r => r._openAp || 0, numeric: true },
  { key: 'dup',         label: 'Status',     type: 'number', get: r => r._isDuplicate ? 0 : 1 },
  { key: '_actions',    label: '',           sortable: false },
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
      <input type="search" id="v-search" placeholder="Search vendors..." class="input" style="max-width:280px">
      <label class="muted" style="font-size:12px;display:flex;gap:6px;align-items:center;cursor:pointer">
        <input type="checkbox" id="v-1099only">1099 only
      </label>
      <label class="muted" style="font-size:12px;display:flex;gap:6px;align-items:center;cursor:pointer">
        <input type="checkbox" id="v-coiissue">COI issues only
      </label>
      <label class="muted" style="font-size:12px;display:flex;gap:6px;align-items:center;cursor:pointer">
        <input type="checkbox" id="v-dupesonly">Possible duplicates only
      </label>
    </div>
    <div id="v-table-wrap" class="table-wrap"><div class="empty-state"><div class="big">LOADING</div></div></div>
  `;
  document.getElementById('new-vendor').onclick = () => editVendor(null, () => loadList());
  document.getElementById('v-search').oninput = filterAndRender;
  document.getElementById('v-1099only').onchange = filterAndRender;
  document.getElementById('v-coiissue').onchange = filterAndRender;
  document.getElementById('v-dupesonly').onchange = filterAndRender;
  await loadList();
}

async function loadList() {
  try {
    const [vendors, billsRaw] = await Promise.all([
      q(supabase.from('vendors').select('*').eq('is_active', true).order('name')),
      q(supabase.from('bills').select('vendor_id, total, amount_paid, status, voided_at')),
    ]);
    const openByVendor = new Map();
    for (const b of billsRaw) {
      if (b.voided_at) continue;
      const open = Number(b.total || 0) - Number(b.amount_paid || 0);
      if (open <= 0) continue;
      openByVendor.set(b.vendor_id, (openByVendor.get(b.vendor_id) || 0) + open);
    }
    const byNorm = new Map();
    for (const v of vendors) {
      const norm = normalizeForDupe(v.name);
      if (!norm) continue;
      if (!byNorm.has(norm)) byNorm.set(norm, []);
      byNorm.get(norm).push(v);
    }
    const duplicateIds = new Set();
    const duplicateGroups = new Map();
    for (const [norm, group] of byNorm) {
      if (group.length > 1) {
        for (const v of group) {
          duplicateIds.add(v.id);
          duplicateGroups.set(v.id, group.filter(g => g.id !== v.id).map(g => g.id));
        }
      }
    }
    for (const v of vendors) {
      v._openAp = openByVendor.get(v.id) || 0;
      v._isDuplicate = duplicateIds.has(v.id);
      v._dupeSiblingIds = duplicateGroups.get(v.id) || [];
    }
    window.__vendorsAll = vendors;
    if (!vendors.length) {
      document.getElementById('v-table-wrap').innerHTML =
        `<div class="empty-state"><div class="big">NO VENDORS</div><div>Click "+ New Vendor" or upload a W-9 in the Inbox.</div></div>`;
      return;
    }
    filterAndRender();
  } catch (e) {
    document.getElementById('v-table-wrap').innerHTML =
      `<div class="empty-state"><div style="color:var(--red)">${escapeHtml(e.message)}</div></div>`;
  }
}

function filterAndRender() {
  const all = window.__vendorsAll || [];
  const term = (document.getElementById('v-search')?.value || '').trim().toLowerCase();
  const only1099 = document.getElementById('v-1099only')?.checked;
  const onlyCoiIssue = document.getElementById('v-coiissue')?.checked;
  const onlyDupes = document.getElementById('v-dupesonly')?.checked;
  let rows = all;
  if (term) rows = rows.filter(v =>
    (v.name || '').toLowerCase().includes(term) ||
    (v.contact || '').toLowerCase().includes(term) ||
    (v.email || '').toLowerCase().includes(term)
  );
  if (only1099) rows = rows.filter(v => v.is_1099);
  if (onlyCoiIssue) rows = rows.filter(v => coiStatus(v) !== 'ON FILE');
  if (onlyDupes) rows = rows.filter(v => v._isDuplicate);
  renderTable(rows);
}

function renderTable(rows) {
  const wrap = document.getElementById('v-table-wrap');
  if (!rows.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="muted">No vendors match your filters.</div></div>`;
    return;
  }
  const state = getSortState(MOD, { key: 'dup', dir: 'asc' });
  const sorted = sortRows(rows, COLUMNS, state);
  wrap.innerHTML = `
    <table class="data">
      <thead><tr>${headerHTML(COLUMNS, state)}</tr></thead>
      <tbody>
        ${sorted.map(v => `
          <tr ${v._isDuplicate ? 'style="background:rgba(245,158,11,0.08)"' : ''}>
            <td>
              <strong>${escapeHtml(v.name)}</strong>
              ${v._isDuplicate ? `<div><span class="pill pill-amber" style="font-size:10px;margin-top:4px">⚠ POSSIBLE DUPLICATE</span></div>` : ''}
            </td>
            <td>${escapeHtml(v.contact || '')}</td>
            <td>${escapeHtml(v.email || '')}</td>
            <td>${escapeHtml(v.phone || '')}</td>
            <td>${v.is_1099 ? '<span class="pill pill-amber">1099</span>' : '<span class="muted">—</span>'}</td>
            <td>${v.w9_url ? `<a href="${escapeHtml(v.w9_url)}" target="_blank">View</a>` : '<span class="muted">—</span>'}</td>
            <td>${coiPill(v)}</td>
            <td class="numeric">${v._openAp ? fmtMoney(v._openAp) : '<span class="muted">—</span>'}</td>
            <td>${v._isDuplicate ? '<span class="pill pill-amber">DUPLICATE?</span>' : '<span class="pill pill-green">OK</span>'}</td>
            <td style="white-space:nowrap">
              <button class="btn-sm btn-ghost edit-vendor" data-id="${v.id}">Edit</button>
              ${(window.__vendorsAll || []).length > 1 ? `<button class="btn-sm btn-ghost merge-vendor" data-id="${v.id}" ${v._isDuplicate ? 'style="color:var(--amber);font-weight:600"' : ''}>Merge</button>` : ''}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  wrap.querySelectorAll('.edit-vendor').forEach(b => {
    b.onclick = () => {
      const v = (window.__vendorsAll || []).find(x => x.id === b.dataset.id);
      editVendor(v, () => loadList());
    };
  });
  wrap.querySelectorAll('.merge-vendor').forEach(b => {
    b.onclick = () => {
      const v = (window.__vendorsAll || []).find(x => x.id === b.dataset.id);
      mergeVendor(v, () => loadList());
    };
  });
  attachSortHandlers(wrap, MOD, () => filterAndRender());
}

function mergeVendor(source, onDone) {
  const all = window.__vendorsAll || [];
  const dupes = (source._dupeSiblingIds || []).map(id => all.find(v => v.id === id)).filter(Boolean);
  const others = all.filter(v => v.id !== source.id && !source._dupeSiblingIds?.includes(v.id));
  const candidates = [...dupes, ...others];
  if (!candidates.length) {
    toast('No other vendors to merge into', { kind: 'error' });
    return;
  }
  const targetOpts = candidates.map(t => {
    const isDupe = (source._dupeSiblingIds || []).includes(t.id);
    return `<option value="${t.id}">${isDupe ? '⚠ ' : ''}${escapeHtml(t.name)}${isDupe ? '  (likely duplicate)' : ''}</option>`;
  }).join('');

  modal({
    title: 'Merge Vendor',
    bodyHTML: `
      <div style="background:var(--ink-50);border-radius:6px;padding:12px;margin-bottom:14px;border-left:3px solid var(--amber)">
        <div class="muted" style="font-size:11px;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:4px">Source (will be deleted)</div>
        <div style="font-weight:600;font-size:14px">${escapeHtml(source.name)}</div>
        <div class="muted" style="font-size:11px;margin-top:4px">
          ${source.email ? '✉ ' + escapeHtml(source.email) + ' · ' : ''}
          ${source.phone ? '☎ ' + escapeHtml(source.phone) + ' · ' : ''}
          ${source.w9_url ? '📄 W-9 · ' : ''}
          ${source.coi_url ? '📋 COI · ' : ''}
          Open AP: ${fmtMoney(source._openAp || 0)}
        </div>
      </div>
      <div class="field">
        <label class="field-label">Merge into vendor *</label>
        <select class="select" id="f-target">${targetOpts}</select>
        ${dupes.length ? `<div class="muted" style="font-size:11px;margin-top:4px;color:var(--amber)">⚠ ${dupes.length} likely duplicate${dupes.length === 1 ? '' : 's'} detected — shown first.</div>` : ''}
      </div>
      <div class="muted" style="font-size:12px;background:var(--ink-50);border-radius:6px;padding:10px;margin-top:8px">
        <strong style="color:var(--ink-700)">What this does:</strong>
        <ul style="margin:6px 0 0 0;padding-left:18px;line-height:1.6">
          <li>Reassigns all bills and payments from this vendor to the target</li>
          <li>Copies W-9 / COI / contact info to the target if it's missing them</li>
          <li>Permanently deletes this vendor record</li>
          <li>This action cannot be undone</li>
        </ul>
      </div>
    `,
    actions: [
      { label: 'Cancel', kind: 'secondary' },
      { label: 'Merge & Delete Source', kind: 'danger', onClick: async (bg) => {
        const targetId = bg.querySelector('#f-target').value;
        if (!targetId) { toast('Select a target vendor', { kind: 'error' }); return false; }
        const target = candidates.find(c => c.id === targetId);
        const ok = await confirmDialog(
          'Confirm merge',
          `Move everything from "${source.name}" into "${target.name}" and permanently delete "${source.name}"?`
        );
        if (!ok) return false;
        try {
          await runMerge(source, target);
          toast('Vendors merged successfully', { kind: 'success' });
          onDone && onDone();
        } catch (e) {
          toast('Merge failed: ' + e.message, { kind: 'error' });
          return false;
        }
      } },
    ],
  });
}

async function runMerge(source, target) {
  await q(supabase.from('bills').update({ vendor_id: target.id }).eq('vendor_id', source.id).select('id'));
  try {
    await supabase.from('payments').update({ vendor_id: target.id }).eq('vendor_id', source.id).select('id');
  } catch (e) { /* payments may not have vendor_id */ }
  const updates = {};
  if (!target.email && source.email) updates.email = source.email;
  if (!target.phone && source.phone) updates.phone = source.phone;
  if (!target.contact && source.contact) updates.contact = source.contact;
  if (!target.address && source.address) updates.address = source.address;
  if (!target.w9_url && source.w9_url) {
    updates.w9_url = source.w9_url;
    updates.w9_received_date = source.w9_received_date;
  }
  if (!target.coi_url && source.coi_url) {
    updates.coi_url = source.coi_url;
    updates.coi_expiry_date = source.coi_expiry_date;
    updates.coi_received_date = source.coi_received_date;
  }
  if (!target.tax_id_encrypted && source.tax_id_encrypted) updates.tax_id_encrypted = source.tax_id_encrypted;
  if (source.is_1099 && !target.is_1099) updates.is_1099 = true;
  if (source.notes) {
    const existingNotes = target.notes || '';
    updates.notes = existingNotes
      ? existingNotes + '\n\n[Merged from "' + source.name + '"]\n' + source.notes
      : '[Merged from "' + source.name + '"]\n' + source.notes;
  }
  if (Object.keys(updates).length) {
    await q(supabase.from('vendors').update(updates).eq('id', target.id));
  }
  await q(supabase.from('vendors').delete().eq('id', source.id));
}

function editVendor(record, onDone) {
  const isNew = !record;
  const r = record || { name: '', contact: '', email: '', phone: '', address: '', is_1099: false, payment_method: 'check', notes: '' };
  modal({
    title: isNew ? 'New Vendor' : 'Edit Vendor',
    bodyHTML: `
      <div class="field"><label class="field-label">Name *</label><input class="input" id="f-name" value="${escapeHtml(r.name || '')}"></div>
      <div class="field-row">
        <div class="field"><label class="field-label">Contact Person</label><input class="input" id="f-contact" value="${escapeHtml(r.contact || '')}"></div>
        <div class="field"><label class="field-label">Payment Method</label>
          <select class="select" id="f-method">
            ${['check','ach','wire','card','cash'].map(m => `<option value="${m}" ${m === (r.payment_method || 'check') ? 'selected' : ''}>${m.toUpperCase()}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label class="field-label">Email</label><input class="input" id="f-email" type="email" value="${escapeHtml(r.email || '')}"></div>
        <div class="field"><label class="field-label">Phone</label><input class="input" id="f-phone" value="${escapeHtml(r.phone || '')}"></div>
      </div>
      <div class="field"><label class="field-label">Address</label><textarea class="input" id="f-addr" rows="2">${escapeHtml(r.address || '')}</textarea></div>
      <div class="field" style="display:flex;gap:8px;align-items:center">
        <input type="checkbox" id="f-1099" ${r.is_1099 ? 'checked' : ''}>
        <label for="f-1099" class="field-label" style="margin:0">1099 Vendor (subcontractor)</label>
      </div>
      <div class="field"><label class="field-label">Upload COI (PDF or image, max 10MB)</label><input type="file" id="f-coi-file" accept="application/pdf,image/*"></div>
      <div class="field-row">
        <div class="field"><label class="field-label">COI Received Date</label><input class="input" id="f-coi-recv" type="date" value="${r.coi_received_date || ''}"></div>
        <div class="field"><label class="field-label">COI Expiry Date</label><input class="input" id="f-coi-exp" type="date" value="${r.coi_expiry_date || ''}"></div>
      </div>
      ${r.coi_url ? `<div class="muted" style="font-size:11px;margin-top:-4px">Current COI: <a href="${escapeHtml(r.coi_url)}" target="_blank">View</a></div>` : ''}
      <div class="field"><label class="field-label">Notes</label><textarea class="input" id="f-notes" rows="2">${escapeHtml(r.notes || '')}</textarea></div>
    `,
    actions: [
      ...(isNew ? [] : [{ label: 'Delete', kind: 'danger', onClick: async () => {
        const ok = await confirmDialog('Delete vendor?', 'Are you sure? This cannot be undone if there are no associated bills.');
        if (!ok) return false;
        try { await q(supabase.from('vendors').delete().eq('id', r.id)); toast('Deleted', { kind: 'success' }); onDone && onDone(); }
        catch (e) { toast('Delete failed (vendor may have bills attached): ' + e.message, { kind: 'error' }); return false; }
      } }]),
      { label: 'Cancel', kind: 'secondary' },
      { label: isNew ? 'Create' : 'Save', kind: 'primary', onClick: async (bg) => {
        const data = {
          name: bg.querySelector('#f-name').value.trim(),
          contact: bg.querySelector('#f-contact').value.trim() || null,
          email: bg.querySelector('#f-email').value.trim() || null,
          phone: bg.querySelector('#f-phone').value.trim() || null,
          address: bg.querySelector('#f-addr').value.trim() || null,
          is_1099: bg.querySelector('#f-1099').checked,
          payment_method: bg.querySelector('#f-method').value,
          notes: bg.querySelector('#f-notes').value.trim() || null,
          coi_received_date: bg.querySelector('#f-coi-recv').value || null,
          coi_expiry_date: bg.querySelector('#f-coi-exp').value || null,
        };
        if (!data.name) { toast('Name is required', { kind: 'error' }); return false; }
        try {
          const coiFile = bg.querySelector('#f-coi-file').files?.[0];
          if (coiFile) {
            if (coiFile.size > 10 * 1024 * 1024) { toast('COI file too large (max 10MB)', { kind: 'error' }); return false; }
            const path = `coi/${Date.now()}_${coiFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
            const { error: upErr } = await supabase.storage.from('coi-documents').upload(path, coiFile);
            if (upErr) throw upErr;
            const { data: urlData } = supabase.storage.from('coi-documents').getPublicUrl(path);
            data.coi_url = urlData.publicUrl;
            if (!data.coi_received_date) data.coi_received_date = new Date().toISOString().slice(0, 10);
          }
          if (isNew) await q(supabase.from('vendors').insert(data));
          else await q(supabase.from('vendors').update(data).eq('id', r.id));
          toast('Saved', { kind: 'success' });
          onDone && onDone();
        } catch (e) { toast('Save failed: ' + e.message, { kind: 'error' }); return false; }
      } },
    ],
  });
}
