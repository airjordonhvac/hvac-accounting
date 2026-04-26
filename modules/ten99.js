// =============================================================================
// 1099s — Year-end 1099-NEC tracking with IRS-format CSV export
// =============================================================================
import { supabase, q } from '../lib/supabase.js';
import { fmtMoney, fmtDate, fmtDateISO, escapeHtml } from '../lib/format.js';
import { toast } from '../lib/toast.js';

export async function renderTen99(outlet) {
  const currentYear = new Date().getFullYear();
  outlet.innerHTML = `
    <div class="page-head">
      <div class="page-head-left">
        <h1>1099 TRACKING</h1>
        <div class="page-head-sub">YTD vendor payments + IRS-format export</div>
      </div>
      <div class="page-head-right">
        <button class="btn-primary" id="export-csv">Export 1099-NEC CSV</button>
      </div>
    </div>
    <div class="toolbar">
      <label class="muted">Tax Year</label>
      <select id="tax-year" class="select" style="max-width:120px">
        ${[currentYear, currentYear - 1, currentYear - 2].map(y => `<option value="${y}">${y}</option>`).join('')}
      </select>
      <label class="muted" style="margin-left:16px;display:flex;gap:6px;align-items:center">
        <input type="checkbox" id="threshold" checked> Only $600+ vendors
      </label>
    </div>
    <div id="ten99-table-wrap" class="table-wrap"><div class="empty-state"><div class="big">LOADING</div></div></div>
  `;
  document.getElementById('tax-year').onchange = load;
  document.getElementById('threshold').onchange = render;
  document.getElementById('export-csv').onclick = exportCSV;
  await load();
}

async function load() {
  const year = Number(document.getElementById('tax-year').value);
  window.__year = year;
  const startISO = `${year}-01-01`;
  const endISO = `${year}-12-31`;
  try {
    const [vendors, payments, applications, bills] = await Promise.all([
      q(supabase.from('vendors').select('*').eq('is_1099', true)),
      q(supabase.from('payments').select('id, amount, date').eq('direction', 'sent').gte('date', startISO).lte('date', endISO)),
      q(supabase.from('payment_applications').select('*')),
      q(supabase.from('bills').select('id, vendor_id')),
    ]);
    const billVendor = new Map(bills.map(b => [b.id, b.vendor_id]));
    const payIds = new Set(payments.map(p => p.id));
    const ven1099Ids = new Set(vendors.map(v => v.id));
    // For each application that targets a bill belonging to a 1099 vendor, sum amount
    const totals = new Map();
    for (const a of applications) {
      if (!a.bill_id || !payIds.has(a.payment_id)) continue;
      const venId = billVendor.get(a.bill_id);
      if (!venId || !ven1099Ids.has(venId)) continue;
      totals.set(venId, (totals.get(venId) || 0) + Number(a.amount));
    }
    window.__rows = vendors.map(v => ({
      id: v.id,
      name: v.name,
      address: v.address || '',
      tax_id: v.tax_id_encrypted ? '✓ on file' : 'MISSING',
      w9: v.w9_url ? 'YES' : 'NO',
      total: totals.get(v.id) || 0,
    })).sort((a, b) => b.total - a.total);
    render();
  } catch (e) {
    document.getElementById('ten99-table-wrap').innerHTML =
      `<div class="empty-state"><div style="color:var(--red)">${escapeHtml(e.message)}</div></div>`;
  }
}

function render() {
  const threshold = document.getElementById('threshold').checked;
  let rows = window.__rows || [];
  if (threshold) rows = rows.filter(r => r.total >= 600);
  const wrap = document.getElementById('ten99-table-wrap');
  if (!rows.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="big">NO QUALIFYING VENDORS</div><div class="muted">Mark vendors with the 1099 toggle and pay them &gt; $600 to see them here.</div></div>`;
    return;
  }
  const total = rows.reduce((s, r) => s + r.total, 0);
  wrap.innerHTML = `
    <div style="margin-bottom:10px"><strong>${rows.length}</strong> vendor${rows.length === 1 ? '' : 's'} · Total: <strong>${fmtMoney(total)}</strong></div>
    <table class="data">
      <thead><tr>
        <th>Vendor</th><th>Address</th><th>Tax ID</th><th>W-9</th><th class="numeric">YTD ${window.__year}</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td><strong>${escapeHtml(r.name)}</strong></td>
            <td>${escapeHtml(r.address)}</td>
            <td>${r.tax_id === 'MISSING' ? `<span style="color:var(--red)">${r.tax_id}</span>` : `<span style="color:var(--green)">${r.tax_id}</span>`}</td>
            <td>${r.w9 === 'YES' ? '<span class="pill pill-paid">✓</span>' : '<span class="pill" style="background:rgba(226,92,92,.18);color:var(--red)">MISSING</span>'}</td>
            <td class="numeric"><strong>${fmtMoney(r.total)}</strong></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function exportCSV() {
  const rows = (window.__rows || []).filter(r => r.total >= 600);
  if (!rows.length) { toast('No qualifying vendors to export', { kind: 'error' }); return; }
  // IRS 1099-NEC format (simplified): Payer, Recipient, TIN, Address, Box 1 (nonemployee comp)
  const data = [['Payer Name', 'Payer TIN', 'Recipient Name', 'Recipient TIN', 'Recipient Address', 'Box 1 NEC Amount'],
    ...rows.map(r => ['Air Jordon HVAC LLC', '', r.name, '', r.address, r.total.toFixed(2)])];
  const csv = data.map(row => row.map(v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `1099-nec-${window.__year}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Exported', { kind: 'success' });
}
