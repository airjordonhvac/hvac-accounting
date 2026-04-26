// =============================================================================
// Payments — unified AR receipts + AP disbursements with apply-to-doc
// =============================================================================
import { supabase, q } from '../lib/supabase.js';
import { fmtMoney, fmtDate, fmtDateISO, escapeHtml } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { confirmDialog, modal } from '../lib/modal.js';

export async function renderPayments(outlet) {
  outlet.innerHTML = `
    <div class="page-head">
      <div class="page-head-left">
        <h1>PAYMENTS</h1>
        <div class="page-head-sub">AR receipts + AP disbursements</div>
      </div>
      <div class="page-head-right">
        <button class="btn-primary" id="new-pay-in">+ Receipt (AR)</button>
        <button class="btn-primary" id="new-pay-out">+ Disbursement (AP)</button>
      </div>
    </div>
    <div class="toolbar">
      <input type="search" id="pay-search" placeholder="Search…" class="input" style="max-width:280px">
      <select id="pay-dir" class="select" style="max-width:160px">
        <option value="">All</option>
        <option value="received">Received</option>
        <option value="sent">Sent</option>
      </select>
    </div>
    <div id="pay-table-wrap" class="table-wrap"><div class="empty-state"><div class="big">LOADING</div></div></div>
  `;
  document.getElementById('new-pay-in').onclick = () => editPayment(null, 'received', () => loadList());
  document.getElementById('new-pay-out').onclick = () => editPayment(null, 'sent', () => loadList());
  document.getElementById('pay-search').oninput = () => filterAndRender();
  document.getElementById('pay-dir').onchange = () => filterAndRender();
  await loadList();
}

async function loadList() {
  const wrap = document.getElementById('pay-table-wrap');
  try {
    const [payments, banks, applications, invoices, bills] = await Promise.all([
      q(supabase.from('payments').select('*').order('date', { ascending: false })),
      q(supabase.from('bank_accounts').select('id, name')),
      q(supabase.from('payment_applications').select('*')),
      q(supabase.from('invoices').select('id, invoice_number, customer_id, total, amount_paid, status')),
      q(supabase.from('bills').select('id, bill_number, vendor_id, total, amount_paid, status')),
    ]);
    const bankMap = new Map(banks.map(b => [b.id, b]));
    const appsByPay = new Map();
    for (const a of applications) {
      if (!appsByPay.has(a.payment_id)) appsByPay.set(a.payment_id, []);
      appsByPay.get(a.payment_id).push(a);
    }
    window.__payAll = payments.map(p => ({ ...p, _bank: bankMap.get(p.bank_account_id), _apps: appsByPay.get(p.id) || [] }));
    window.__payInvoices = invoices;
    window.__payBills = bills;
    window.__payBanks = banks;
    filterAndRender();
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state"><div style="color:var(--red)">${escapeHtml(e.message)}</div></div>`;
  }
}

function filterAndRender() {
  const all = window.__payAll || [];
  const term = (document.getElementById('pay-search')?.value || '').trim().toLowerCase();
  const dir = document.getElementById('pay-dir')?.value || '';
  let rows = all;
  if (term) rows = rows.filter(p =>
    (p.reference || '').toLowerCase().includes(term) ||
    (p.memo || '').toLowerCase().includes(term));
  if (dir) rows = rows.filter(p => p.direction === dir);
  renderTable(rows);
}

function renderTable(rows) {
  const wrap = document.getElementById('pay-table-wrap');
  if (!rows.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="big">NO PAYMENTS</div></div>`;
    return;
  }
  wrap.innerHTML = `
    <table class="data">
      <thead><tr>
        <th>Date</th><th>Direction</th><th>Method</th><th>Reference</th><th>Bank</th>
        <th class="numeric">Amount</th><th>Applied</th><th></th>
      </tr></thead>
      <tbody>
        ${rows.map(p => {
          const applied = (p._apps || []).reduce((s, a) => s + Number(a.amount), 0);
          const unapplied = Number(p.amount) - applied;
          return `
          <tr>
            <td>${fmtDate(p.date)}</td>
            <td>${p.direction === 'received' ? '<span class="pill pill-green">IN</span>' : '<span class="pill pill-amber">OUT</span>'}</td>
            <td>${escapeHtml((p.method || '').toUpperCase())}</td>
            <td class="mono">${escapeHtml(p.reference || '')}</td>
            <td>${escapeHtml(p._bank?.name || '—')}</td>
            <td class="numeric">${fmtMoney(p.amount)}</td>
            <td>${(p._apps || []).length} doc(s)${unapplied > 0.01 ? `<div class="muted" style="color:var(--amber)">${fmtMoney(unapplied)} unapplied</div>` : ''}</td>
            <td><button class="btn-sm btn-ghost edit-btn" data-id="${p.id}">Edit</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
  wrap.querySelectorAll('.edit-btn').forEach(btn => {
    btn.onclick = () => {
      const p = (window.__payAll || []).find(x => x.id === btn.dataset.id);
      editPayment(p, p.direction, () => loadList());
    };
  });
}

async function editPayment(record, direction, onDone) {
  const isNew = !record;
  const r = record || { date: fmtDateISO(new Date()), amount: 0, direction, method: 'check', reference: '', bank_account_id: null, memo: '' };
  const banks = window.__payBanks || [];
  const docs = direction === 'received'
    ? (window.__payInvoices || []).filter(i => i.status !== 'void' && i.status !== 'draft' && Number(i.total) - Number(i.amount_paid) > 0.01)
    : (window.__payBills || []).filter(b => b.status !== 'void' && Number(b.total) - Number(b.amount_paid) > 0.01);
  let existingApps = r._apps || [];
  if (!isNew && !existingApps.length) {
    try { existingApps = await q(supabase.from('payment_applications').select('*').eq('payment_id', r.id)); }
    catch { existingApps = []; }
  }
  const bankOpts = `<option value="">— Select bank —</option>` + banks.map(b => `<option value="${b.id}" ${b.id === r.bank_account_id ? 'selected' : ''}>${escapeHtml(b.name)}</option>`).join('');
  const docLabel = direction === 'received' ? 'Invoice' : 'Bill';
  const docKey = direction === 'received' ? 'invoice_id' : 'bill_id';
  const numField = direction === 'received' ? 'invoice_number' : 'bill_number';
  const docMap = new Map(docs.map(d => [d.id, d]));
  const docRows = (apps) => apps.map((a, i) => {
    const docId = a[docKey];
    const doc = docMap.get(docId);
    const docOpts = `<option value="">— Select —</option>` + docs.map(d => {
      const open = (Number(d.total) - Number(d.amount_paid)).toFixed(2);
      return `<option value="${d.id}" ${d.id === docId ? 'selected' : ''}>${escapeHtml(d[numField] || '')} — open ${open}</option>`;
    }).join('');
    return `
      <tr class="app-row" data-i="${i}">
        <td><select class="select" data-f="doc">${docOpts}</select></td>
        <td><input class="input numeric" data-f="amount" type="number" step="0.01" value="${a.amount || 0}" style="width:120px"></td>
        <td><button class="btn-sm btn-ghost rm-app" type="button">×</button></td>
      </tr>`;
  }).join('');
  modal({
    title: isNew ? `New ${direction === 'received' ? 'Receipt' : 'Disbursement'}` : 'Edit Payment',
    bodyHTML: `
      <div class="field-row-3">
        <div class="field"><label class="field-label">Date *</label><input class="input" id="f-date" type="date" value="${r.date || ''}"></div>
        <div class="field"><label class="field-label">Amount *</label><input class="input numeric" id="f-amt" type="number" step="0.01" value="${r.amount || 0}"></div>
        <div class="field"><label class="field-label">Method</label>
          <select class="select" id="f-method">
            ${['check','ach','card','cash','wire'].map(m => `<option value="${m}" ${m === r.method ? 'selected' : ''}>${m.toUpperCase()}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label class="field-label">Bank Account *</label><select class="select" id="f-bank">${bankOpts}</select></div>
        <div class="field"><label class="field-label">Reference</label><input class="input mono" id="f-ref" value="${escapeHtml(r.reference || '')}" placeholder="check #, conf #"></div>
      </div>
      <div class="line-items" style="margin-top:14px">
        <div class="section-title">APPLY TO ${docLabel.toUpperCase()}(S)</div>
        <table class="data">
          <thead><tr><th>${docLabel}</th><th>Amount</th><th></th></tr></thead>
          <tbody id="app-body">${docRows(existingApps.length ? existingApps : [{ amount: 0 }])}</tbody>
        </table>
        <button class="btn-sm btn-ghost" type="button" id="add-app">+ Add</button>
      </div>
      <div class="field"><label class="field-label">Memo</label><textarea class="input" id="f-memo" rows="2">${escapeHtml(r.memo || '')}</textarea></div>
    `,
    actions: [
      ...(isNew ? [] : [{ label: 'Delete', kind: 'danger', onClick: async () => {
        const ok = await confirmDialog('Delete payment?', 'This will reverse all applications and recompute paid amounts.');
        if (!ok) return false;
        try {
          await q(supabase.from('payment_applications').delete().eq('payment_id', r.id));
          await q(supabase.from('payments').delete().eq('id', r.id));
          await recomputePaidAll();
          toast('Deleted', { kind: 'success' });
          onDone && onDone();
        } catch (e) { toast('Failed: ' + e.message, { kind: 'error' }); return false; }
      } }]),
      { label: 'Cancel', kind: 'secondary' },
      { label: isNew ? 'Create' : 'Save', kind: 'primary', onClick: async (bg) => {
        const apps = [...bg.querySelectorAll('.app-row')].map(row => ({
          [docKey]: row.querySelector('[data-f=doc]').value || null,
          amount: Number(row.querySelector('[data-f=amount]').value) || 0,
        })).filter(a => a[docKey] && a.amount > 0);
        const data = {
          date: bg.querySelector('#f-date').value,
          amount: Number(bg.querySelector('#f-amt').value) || 0,
          direction,
          method: bg.querySelector('#f-method').value,
          reference: bg.querySelector('#f-ref').value.trim() || null,
          bank_account_id: bg.querySelector('#f-bank').value || null,
          memo: bg.querySelector('#f-memo').value.trim() || null,
        };
        if (!data.bank_account_id) { toast('Bank account is required', { kind: 'error' }); return false; }
        if (data.amount <= 0) { toast('Amount must be > 0', { kind: 'error' }); return false; }
        try {
          let payId = r.id;
          if (isNew) {
            const ins = await q(supabase.from('payments').insert(data).select().single());
            payId = ins.id;
          } else {
            await q(supabase.from('payments').update(data).eq('id', r.id));
            await q(supabase.from('payment_applications').delete().eq('payment_id', r.id));
          }
          if (apps.length) {
            await q(supabase.from('payment_applications').insert(apps.map(a => ({ ...a, payment_id: payId }))));
          }
          await recomputePaidAll();
          toast('Saved', { kind: 'success' });
          onDone && onDone();
        } catch (e) { toast('Save failed: ' + e.message, { kind: 'error' }); return false; }
      } },
    ],
  });
  setTimeout(() => {
    const body = document.querySelector('#app-body');
    body.addEventListener('change', (e) => {
      if (e.target.matches('[data-f=doc]')) {
        const docId = e.target.value;
        const doc = docMap.get(docId);
        if (doc) {
          const open = Number(doc.total) - Number(doc.amount_paid);
          const amtIn = e.target.closest('tr').querySelector('[data-f=amount]');
          if (Number(amtIn.value) === 0) amtIn.value = open.toFixed(2);
        }
      }
    });
    body.addEventListener('click', (e) => {
      if (e.target.matches('.rm-app')) e.target.closest('tr').remove();
    });
    document.querySelector('#add-app').addEventListener('click', () => {
      const tmp = document.createElement('tbody');
      const idx = body.querySelectorAll('.app-row').length;
      tmp.innerHTML = docRows([{ amount: 0 }]);
      body.appendChild(tmp.querySelector('tr'));
    });
  }, 50);
}

async function recomputePaidAll() {
  // Recompute amount_paid for all invoices and bills based on payment_applications
  try {
    const apps = await q(supabase.from('payment_applications').select('*'));
    const invSums = new Map();
    const billSums = new Map();
    for (const a of apps) {
      if (a.invoice_id) invSums.set(a.invoice_id, (invSums.get(a.invoice_id) || 0) + Number(a.amount));
      if (a.bill_id) billSums.set(a.bill_id, (billSums.get(a.bill_id) || 0) + Number(a.amount));
    }
    const [invs, bills] = await Promise.all([
      q(supabase.from('invoices').select('id, total, status')),
      q(supabase.from('bills').select('id, total, status')),
    ]);
    for (const inv of invs) {
      if (inv.status === 'void') continue;
      const paid = invSums.get(inv.id) || 0;
      let status = inv.status === 'draft' ? 'draft' : 'sent';
      if (paid > 0 && paid < Number(inv.total)) status = 'partial';
      if (paid >= Number(inv.total) - 0.01) status = 'paid';
      await supabase.from('invoices').update({ amount_paid: paid, status }).eq('id', inv.id);
    }
    for (const b of bills) {
      if (b.status === 'void') continue;
      const paid = billSums.get(b.id) || 0;
      let status = 'open';
      if (paid > 0 && paid < Number(b.total)) status = 'partial';
      if (paid >= Number(b.total) - 0.01) status = 'paid';
      await supabase.from('bills').update({ amount_paid: paid, status }).eq('id', b.id);
    }
  } catch (e) { console.warn('[recompute paid]', e); }
}
