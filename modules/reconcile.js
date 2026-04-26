// =============================================================================
// Reconcile — statement reconciliation flow
// =============================================================================
import { supabase, q } from '../lib/supabase.js';
import { fmtMoney, fmtDate, fmtDateISO, escapeHtml } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { confirmDialog, modal } from '../lib/modal.js';

export async function renderReconcile(outlet) {
  outlet.innerHTML = `
    <div class="page-head">
      <div class="page-head-left">
        <h1>RECONCILE</h1>
        <div class="page-head-sub">Match statement to transactions</div>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><div class="section-title">SETUP</div></div>
      <div class="field-row-3">
        <div class="field"><label class="field-label">Bank Account</label><select id="f-bank" class="select"><option value="">Loading…</option></select></div>
        <div class="field"><label class="field-label">Statement Date</label><input id="f-date" type="date" class="input" value="${fmtDateISO(new Date())}"></div>
        <div class="field"><label class="field-label">Statement Balance</label><input id="f-balance" type="number" step="0.01" class="input" value="0"></div>
      </div>
      <button class="btn-primary" id="start">Start Reconciliation</button>
    </div>
    <div id="recon-area" style="margin-top:16px;display:none"></div>
  `;
  try {
    const banks = await q(supabase.from('bank_accounts').select('id, name, account_type').eq('is_active', true));
    document.getElementById('f-bank').innerHTML = banks.map(b =>
      `<option value="${b.id}">${escapeHtml(b.name)} (${escapeHtml(b.account_type)})</option>`
    ).join('');
    window.__banks = banks;
  } catch (e) {
    document.getElementById('f-bank').innerHTML = `<option>Error loading: ${escapeHtml(e.message)}</option>`;
  }
  document.getElementById('start').onclick = startReconcile;
}

async function startReconcile() {
  const bankId = document.getElementById('f-bank').value;
  const stmtDate = document.getElementById('f-date').value;
  const stmtBalance = Number(document.getElementById('f-balance').value) || 0;
  if (!bankId || !stmtDate) { toast('Fill all fields', { kind: 'error' }); return; }

  const area = document.getElementById('recon-area');
  area.style.display = 'block';
  area.innerHTML = `<div class="empty-state"><div class="big">LOADING</div></div>`;

  try {
    // Pull all unreconciled transactions on or before the statement date
    const tx = await q(supabase.from('bank_transactions')
      .select('*')
      .eq('bank_account_id', bankId)
      .eq('reconciled', false)
      .lte('date', stmtDate)
      .order('date'));
    window.__reconTx = tx;
    window.__reconCheck = new Set();
    drawRecon(stmtBalance);
  } catch (e) {
    area.innerHTML = `<div class="empty-state"><div style="color:var(--red)">${escapeHtml(e.message)}</div></div>`;
  }
}

function drawRecon(stmtBalance) {
  const area = document.getElementById('recon-area');
  const tx = window.__reconTx;
  if (!tx.length) {
    area.innerHTML = `<div class="empty-state"><div class="big">NOTHING TO RECONCILE</div><div class="muted">No unreconciled transactions on or before this date. Import a statement first.</div></div>`;
    return;
  }
  area.innerHTML = `
    <div class="recon-summary" id="recon-sum"></div>
    <div class="card">
      <div class="card-header"><div class="section-title">UNRECONCILED TRANSACTIONS</div>
        <div><button class="btn-sm btn-ghost" id="check-all">Check all</button> <button class="btn-sm btn-ghost" id="uncheck-all">Uncheck all</button></div>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr>
            <th></th><th>Date</th><th>Description</th><th class="numeric">Amount</th>
          </tr></thead>
          <tbody id="recon-rows"></tbody>
        </table>
      </div>
    </div>
    <button class="btn-primary" style="margin-top:14px" id="finalize">Lock Reconciliation</button>
  `;
  const tbody = document.getElementById('recon-rows');
  tbody.innerHTML = tx.map(t => `
    <tr data-id="${t.id}">
      <td><input type="checkbox" data-id="${t.id}" data-amount="${t.amount}" class="recon-cb"></td>
      <td>${fmtDate(t.date)}</td>
      <td>${escapeHtml(t.description || '')}</td>
      <td class="numeric ${Number(t.amount) < 0 ? 'neg' : ''}">${fmtMoney(t.amount)}</td>
    </tr>
  `).join('');

  const updateSum = () => {
    const checked = tbody.querySelectorAll('.recon-cb:checked');
    const cleared = [...checked].reduce((s, cb) => s + Number(cb.dataset.amount), 0);
    const diff = stmtBalance - cleared;
    document.getElementById('recon-sum').innerHTML = `
      <div class="item"><div class="label">Statement balance</div><div class="val">${fmtMoney(stmtBalance)}</div></div>
      <div class="item"><div class="label">Cleared (selected)</div><div class="val">${fmtMoney(cleared)}</div></div>
      <div class="item"><div class="label">Selected count</div><div class="val">${checked.length}</div></div>
      <div class="item"><div class="label">Difference</div><div class="val ${Math.abs(diff) < 0.01 ? 'zero' : 'diff'}">${fmtMoney(diff)}</div></div>
    `;
  };
  tbody.querySelectorAll('.recon-cb').forEach(cb => cb.onchange = updateSum);
  document.getElementById('check-all').onclick = () => { tbody.querySelectorAll('.recon-cb').forEach(cb => cb.checked = true); updateSum(); };
  document.getElementById('uncheck-all').onclick = () => { tbody.querySelectorAll('.recon-cb').forEach(cb => cb.checked = false); updateSum(); };
  document.getElementById('finalize').onclick = () => finalize(stmtBalance);
  updateSum();
}

async function finalize(stmtBalance) {
  const checked = document.querySelectorAll('#recon-rows .recon-cb:checked');
  if (!checked.length) { toast('Select transactions to mark reconciled', { kind: 'error' }); return; }
  const cleared = [...checked].reduce((s, cb) => s + Number(cb.dataset.amount), 0);
  const diff = stmtBalance - cleared;
  let proceed = true;
  if (Math.abs(diff) > 0.01) {
    proceed = await confirmDialog('Difference is not zero', `Statement = ${fmtMoney(stmtBalance)}, cleared = ${fmtMoney(cleared)}, difference = ${fmtMoney(diff)}. Continue anyway?`);
  }
  if (!proceed) return;
  const ids = [...checked].map(cb => cb.dataset.id);
  const bankId = document.getElementById('f-bank').value;
  const stmtDate = document.getElementById('f-date').value;
  try {
    await q(supabase.from('reconciliations').insert({
      bank_account_id: bankId,
      statement_date: stmtDate,
      statement_balance: stmtBalance,
      cleared_balance: cleared,
      difference: diff,
      status: 'complete',
      completed_at: new Date().toISOString(),
    }));
    // Mark transactions reconciled
    await q(supabase.from('bank_transactions').update({ reconciled: true }).in('id', ids));
    toast(`Reconciled ${ids.length} transactions`, { kind: 'success' });
    document.getElementById('recon-area').innerHTML = `<div class="empty-state"><div class="big" style="color:var(--green)">DONE</div><div>${ids.length} transactions reconciled.</div></div>`;
  } catch (e) { toast('Failed: ' + e.message, { kind: 'error' }); }
}
