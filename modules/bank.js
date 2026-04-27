// =============================================================================
// Bank — Per-account dashboard
// Credit-aware: switches language when account_type='credit' (CHARGES, PAYMENTS,
// AMOUNT OWED instead of WITHDRAWALS, DEPOSITS, CURRENT BALANCE).
// Categorization: tx table has inline category picker; Spending-by-Category
// chart for credit accounts; "Apply auto-rules" button runs categorization_rules
// retroactively for unset tx.
// =============================================================================
import { supabase, q } from '../lib/supabase.js';
import { fmtMoney, fmtDate, fmtDateISO, escapeHtml } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { confirmDialog, modal } from '../lib/modal.js';
import { sortRows, headerHTML, attachSortHandlers, getSortState } from '../lib/sort.js';

const TX_MOD = 'bank_tx';

// Returns the {label} object for a given account type, used to flip terminology
// for credit cards vs checking/savings accounts.
function lex(acctType) {
  const isCredit = acctType === 'credit';
  return {
    isCredit,
    balanceLbl:    isCredit ? 'AMOUNT OWED'   : 'CURRENT BALANCE',
    incomingLbl:   isCredit ? 'PAYMENTS'      : 'DEPOSITS',
    outgoingLbl:   isCredit ? 'CHARGES'       : 'WITHDRAWALS',
    netLbl:        isCredit ? 'NET ACTIVITY'  : 'NET CHANGE',
  };
}

const TX_COLUMNS = [
  { key: 'date',          label: 'Date',        type: 'date' },
  { key: 'description',   label: 'Description', type: 'string' },
  { key: 'amount',        label: 'Amount',      type: 'number', numeric: true },
  { key: 'balance_after', label: 'Balance',     type: 'number', numeric: true },
  { key: 'category',      label: 'Category',    type: 'string', get: r => r._cat?.name || '' },
  { key: 'reconciled',    label: 'Reconciled',  type: 'number', get: r => r.reconciled ? 1 : 0 },
];

export async function renderBank(outlet) {
  outlet.innerHTML = `
    <div class="page-head">
      <div class="page-head-left">
        <h1>BANK</h1>
        <div class="page-head-sub">Cash + credit dashboard per account</div>
      </div>
      <div class="page-head-right">
        <button class="btn-secondary" id="manage-accts">Manage Accounts</button>
      </div>
    </div>
    <div id="bank-area"><div class="empty-state"><div class="big">LOADING</div></div></div>
  `;
  document.getElementById('manage-accts').onclick = () => openAccountManager();
  await loadAll();
}

async function loadAll() {
  const area = document.getElementById('bank-area');
  try {
    const [accts, allTx, cats, rules] = await Promise.all([
      q(supabase.from('bank_accounts').select('*').eq('is_active', true).order('name')),
      q(supabase.from('bank_transactions').select('*').order('date', { ascending: true })),
      q(supabase.from('transaction_categories').select('*').eq('is_active', true).order('display_order')),
      q(supabase.from('categorization_rules').select('*').eq('is_active', true).order('priority')),
    ]);
    if (!accts.length) {
      area.innerHTML = `<div class="empty-state"><div class="big">NO ACCOUNTS</div><div>Click "Manage Accounts" to add your first one.</div></div>`;
      return;
    }
    const catMap = new Map(cats.map(c => [c.id, c]));
    window.__bankAccts = accts;
    window.__bankCats = cats;
    window.__bankRules = rules;
    window.__bankTxAll = allTx.map(t => ({ ...t, _cat: t.category_id ? catMap.get(t.category_id) : null }));
    const sel = window.__selectedAcctId && accts.find(a => a.id === window.__selectedAcctId)
      ? window.__selectedAcctId
      : accts[0].id;
    window.__selectedAcctId = sel;
    renderDashboard();
  } catch (e) {
    area.innerHTML = `<div class="empty-state"><div style="color:var(--red)">${escapeHtml(e.message)}</div></div>`;
  }
}

function renderDashboard() {
  const accts = window.__bankAccts || [];
  const acctId = window.__selectedAcctId;
  const acct = accts.find(a => a.id === acctId);
  const txs = (window.__bankTxAll || []).filter(t => t.bank_account_id === acctId);
  const L = lex(acct?.account_type);

  const sortedDesc = [...txs].sort((a, b) =>
    b.date.localeCompare(a.date) || (b.created_at || '').localeCompare(a.created_at || '')
  );
  const latestWithBalance = sortedDesc.find(t => t.balance_after != null);
  const liveBalance = latestWithBalance
    ? Number(latestWithBalance.balance_after)
    : Number(acct?.current_balance || 0);
  const balanceAsOfDate = latestWithBalance ? latestWithBalance.date : (sortedDesc[0]?.date || null);

  // For credit accounts, "incoming" = payments made (negative amount on statement),
  // "outgoing" = charges (positive amount on statement). For checking, opposite.
  // We treat the sign convention as: positive amount = money in, negative = money out
  // (which is what bank statements typically extract). For credit cards, charges are
  // negative (you owe more) and payments are positive (you owe less). The Edge Function
  // already encodes this consistently.
  let incoming = 0, outgoing = 0;
  let latestPeriodLabel = '', latestPeriodKey = '';
  if (sortedDesc.length) {
    latestPeriodKey = sortedDesc[0].date.slice(0, 7);
    const periodStart = latestPeriodKey + '-01';
    const periodEnd = latestPeriodKey + '-31';
    for (const t of txs) {
      if (t.date < periodStart || t.date > periodEnd) continue;
      const a = Number(t.amount);
      if (a > 0) incoming += a;
      else outgoing += a;
    }
    const d = new Date(periodStart + 'T00:00:00');
    latestPeriodLabel = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  const net = incoming + outgoing;

  // Statement period for the meta strip
  const lastBatchId = sortedDesc.length ? sortedDesc[0].import_batch_id : null;
  const lastBatchTx = lastBatchId ? txs.filter(t => t.import_batch_id === lastBatchId) : [];
  const batchStart = lastBatchTx.length ? lastBatchTx.reduce((m, t) => t.date < m ? t.date : m, lastBatchTx[0].date) : null;
  const batchEnd = lastBatchTx.length ? lastBatchTx.reduce((m, t) => t.date > m ? t.date : m, lastBatchTx[0].date) : null;

  // Uncategorized count
  const unCatCount = txs.filter(t => !t.category_id).length;

  const acctOpts = accts.map(a => {
    const tag = a.account_type === 'credit' ? '[CREDIT] ' : '';
    return `<option value="${a.id}" ${a.id === acctId ? 'selected' : ''}>${tag}${escapeHtml(a.name)} ····${a.last4 || '—'}</option>`;
  }).join('');

  document.getElementById('bank-area').innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <div>
          <div class="muted" style="font-size:11px;letter-spacing:0.5px;text-transform:uppercase">Account</div>
          <select id="acct-picker" class="select" style="min-width:280px;font-size:14px;font-weight:600">${acctOpts}</select>
        </div>
        <div style="border-left:1px solid var(--hairline);padding-left:14px">
          <div class="muted" style="font-size:11px;letter-spacing:0.5px;text-transform:uppercase">Type</div>
          <div style="font-weight:600;${L.isCredit ? 'color:var(--gold)' : ''}">${escapeHtml((acct?.account_type || '').toUpperCase())}</div>
        </div>
        <div style="border-left:1px solid var(--hairline);padding-left:14px">
          <div class="muted" style="font-size:11px;letter-spacing:0.5px;text-transform:uppercase">Last 4</div>
          <div class="mono" style="font-weight:600">····${acct?.last4 || '—'}</div>
        </div>
        ${batchStart ? `
        <div style="border-left:1px solid var(--hairline);padding-left:14px">
          <div class="muted" style="font-size:11px;letter-spacing:0.5px;text-transform:uppercase">Latest Statement</div>
          <div style="font-weight:600">${fmtDate(batchStart)} → ${fmtDate(batchEnd)}</div>
        </div>` : ''}
        <div style="margin-left:auto;display:flex;gap:8px">
          ${unCatCount > 0 ? `<button class="btn-sm btn-primary" id="apply-rules-btn">Apply Rules (${unCatCount} uncat.)</button>` : ''}
          <button class="btn-sm btn-ghost" id="import-csv-btn">Import CSV</button>
        </div>
      </div>
    </div>

    <div class="summary-grid" style="margin-bottom:14px">
      <div class="summary-cell">
        <div class="muted">${L.balanceLbl}</div>
        <div class="big" style="${L.isCredit && liveBalance < 0 ? 'color:var(--red)' : ''}">${fmtMoney(L.isCredit ? Math.abs(liveBalance) : liveBalance)}</div>
        <div class="muted" style="font-size:11px">${balanceAsOfDate ? `as of ${fmtDate(balanceAsOfDate)}` : 'no transactions yet'}</div>
      </div>
      <div class="summary-cell">
        <div class="muted">${L.incomingLbl}</div>
        <div class="big" style="color:var(--green)">${fmtMoney(incoming)}</div>
        <div class="muted" style="font-size:11px">${latestPeriodLabel || 'no data'}</div>
      </div>
      <div class="summary-cell">
        <div class="muted">${L.outgoingLbl}</div>
        <div class="big" style="color:var(--red)">${fmtMoney(Math.abs(outgoing))}</div>
        <div class="muted" style="font-size:11px">${latestPeriodLabel || 'no data'}</div>
      </div>
      <div class="summary-cell">
        <div class="muted">${L.netLbl}</div>
        <div class="big" style="color:${net >= 0 ? 'var(--green)' : 'var(--red)'}">${net >= 0 ? '+' : ''}${fmtMoney(net)}</div>
        <div class="muted" style="font-size:11px">${latestPeriodLabel ? `for ${latestPeriodLabel}` : 'no data'}</div>
      </div>
      <div class="summary-cell">
        <div class="muted">TRANSACTIONS</div>
        <div class="big">${txs.length}</div>
        <div class="muted" style="font-size:11px">${unCatCount > 0 ? `<span style="color:var(--amber)">${unCatCount} uncategorized</span>` : 'all categorized'}</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-header">
        <div class="section-title">RUNNING BALANCE</div>
        <div class="muted" style="font-size:11px">Daily balance over time</div>
      </div>
      <div id="balance-chart"></div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-header">
        <div class="section-title">${L.incomingLbl} VS ${L.outgoingLbl} BY MONTH</div>
        <div class="muted" style="font-size:11px">Last 12 months</div>
      </div>
      <div id="month-chart"></div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div class="section-title">SPENDING BY CATEGORY</div>
          <div class="muted" style="font-size:11px">Where the money went</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <label class="muted" style="font-size:11px">Range</label>
          <select id="cat-range" class="select" style="font-size:12px">
            <option value="latest">Latest period</option>
            <option value="ytd" selected>Year to date</option>
            <option value="all">All time</option>
            <option value="lastperiod">Last completed period</option>
          </select>
        </div>
      </div>
      <div id="cat-chart"></div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="section-title">TRANSACTIONS</div>
      </div>
      <div class="toolbar">
        <input type="search" id="tx-search" placeholder="Search description…" class="input" style="max-width:220px">
        <label class="muted" style="font-size:11px">From</label>
        <input class="input" id="tx-from" type="date" style="max-width:160px">
        <label class="muted" style="font-size:11px">To</label>
        <input class="input" id="tx-to" type="date" style="max-width:160px">
        <select id="tx-type" class="select" style="max-width:160px">
          <option value="">All types</option>
          <option value="deposits">${L.incomingLbl} only</option>
          <option value="withdrawals">${L.outgoingLbl} only</option>
        </select>
        <select id="tx-cat" class="select" style="max-width:200px">
          <option value="">All categories</option>
          <option value="__none__">— Uncategorized —</option>
          ${(window.__bankCats || []).map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
        </select>
        <select id="tx-recon" class="select" style="max-width:160px">
          <option value="">All</option>
          <option value="reconciled">Reconciled</option>
          <option value="unreconciled">Unreconciled</option>
        </select>
        <button class="btn-sm btn-ghost" id="tx-clear-filters">Clear</button>
      </div>
      <div id="tx-table-wrap" class="table-wrap"></div>
    </div>
  `;

  document.getElementById('acct-picker').onchange = (e) => {
    window.__selectedAcctId = e.target.value;
    renderDashboard();
  };
  document.getElementById('import-csv-btn').onclick = () => importCSV(acctId, () => loadAll());
  const arBtn = document.getElementById('apply-rules-btn');
  if (arBtn) arBtn.onclick = () => applyRulesRetroactively(acctId, () => loadAll());

  drawBalanceChart(txs, L);
  drawMonthChart(txs, L);
  drawCategoryChart();

  document.getElementById('cat-range').onchange = drawCategoryChart;
  document.getElementById('tx-search').oninput = renderTxTable;
  document.getElementById('tx-from').onchange = renderTxTable;
  document.getElementById('tx-to').onchange = renderTxTable;
  document.getElementById('tx-type').onchange = renderTxTable;
  document.getElementById('tx-cat').onchange = renderTxTable;
  document.getElementById('tx-recon').onchange = renderTxTable;
  document.getElementById('tx-clear-filters').onclick = () => {
    ['tx-search','tx-from','tx-to'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('tx-type').value = '';
    document.getElementById('tx-cat').value = '';
    document.getElementById('tx-recon').value = '';
    renderTxTable();
  };
  renderTxTable();
}

function renderTxTable() {
  const acctId = window.__selectedAcctId;
  const allTx = window.__bankTxAll || [];
  let txs = allTx.filter(t => t.bank_account_id === acctId);

  const term = (document.getElementById('tx-search')?.value || '').trim().toLowerCase();
  const from = document.getElementById('tx-from')?.value || '';
  const to = document.getElementById('tx-to')?.value || '';
  const type = document.getElementById('tx-type')?.value || '';
  const catFilter = document.getElementById('tx-cat')?.value || '';
  const recon = document.getElementById('tx-recon')?.value || '';

  if (term) txs = txs.filter(t => (t.description || '').toLowerCase().includes(term));
  if (from) txs = txs.filter(t => t.date >= from);
  if (to) txs = txs.filter(t => t.date <= to);
  if (type === 'deposits') txs = txs.filter(t => Number(t.amount) > 0);
  if (type === 'withdrawals') txs = txs.filter(t => Number(t.amount) < 0);
  if (catFilter === '__none__') txs = txs.filter(t => !t.category_id);
  else if (catFilter) txs = txs.filter(t => t.category_id === catFilter);
  if (recon === 'reconciled') txs = txs.filter(t => t.reconciled);
  if (recon === 'unreconciled') txs = txs.filter(t => !t.reconciled);

  const wrap = document.getElementById('tx-table-wrap');
  if (!txs.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="muted">No transactions match your filters.</div></div>`;
    return;
  }

  const totals = txs.reduce((acc, t) => {
    const a = Number(t.amount);
    if (a > 0) acc.deposits += a;
    else acc.withdrawals += a;
    return acc;
  }, { deposits: 0, withdrawals: 0 });

  const cats = window.__bankCats || [];
  const catOpts = (selId) => `<option value="">— Uncat. —</option>` + cats.map(c =>
    `<option value="${c.id}" ${c.id === selId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
  ).join('');

  const state = getSortState(TX_MOD, { key: 'date', dir: 'desc' });
  const sorted = sortRows(txs, TX_COLUMNS, state);
  wrap.innerHTML = `
    <table class="data">
      <thead><tr>${headerHTML(TX_COLUMNS, state)}</tr></thead>
      <tbody>
        ${sorted.map(t => `
          <tr>
            <td>${fmtDate(t.date)}</td>
            <td>${escapeHtml(t.description || '')}</td>
            <td class="numeric ${Number(t.amount) < 0 ? 'delta-down' : 'delta-up'}">${fmtMoney(t.amount)}</td>
            <td class="numeric">${t.balance_after != null ? fmtMoney(t.balance_after) : '<span class="muted">—</span>'}</td>
            <td>
              <select class="select cat-picker" data-id="${t.id}" style="font-size:11px;padding:4px 6px;background:${t._cat?.color || 'transparent'}${t._cat ? '33' : ''};border-color:${t._cat?.color || 'var(--hairline)'};">${catOpts(t.category_id)}</select>
            </td>
            <td>${t.reconciled ? '<span class="pill pill-green">YES</span>' : '<span class="pill pill-amber">PENDING</span>'}</td>
          </tr>
        `).join('')}
      </tbody>
      <tfoot>
        <tr style="font-weight:600;background:var(--ink-50)">
          <td colspan="2"><strong>${txs.length} transactions</strong></td>
          <td class="numeric">
            <div class="delta-up">+${fmtMoney(totals.deposits)}</div>
            <div class="delta-down">${fmtMoney(totals.withdrawals)}</div>
            <div style="border-top:1px solid var(--hairline);margin-top:2px;padding-top:2px">
              <strong>${(totals.deposits + totals.withdrawals) >= 0 ? '+' : ''}${fmtMoney(totals.deposits + totals.withdrawals)}</strong>
            </div>
          </td>
          <td colspan="3"></td>
        </tr>
      </tfoot>
    </table>
  `;

  // Wire up inline category pickers
  wrap.querySelectorAll('.cat-picker').forEach(sel => {
    sel.addEventListener('change', async (e) => {
      const txId = sel.dataset.id;
      const newCatId = sel.value || null;
      try {
        await q(supabase.from('bank_transactions').update({ category_id: newCatId }).eq('id', txId));
        // Update local state without full reload
        const local = (window.__bankTxAll || []).find(t => t.id === txId);
        if (local) {
          local.category_id = newCatId;
          local._cat = newCatId ? (window.__bankCats || []).find(c => c.id === newCatId) : null;
        }
        toast('Category updated', { kind: 'success', ms: 1500 });
        renderTxTable();
        drawCategoryChart();
        // Update KPI strip's uncategorized count
        const accts = window.__bankAccts || [];
        const acctTxs = (window.__bankTxAll || []).filter(t => t.bank_account_id === window.__selectedAcctId);
        const unCatCount = acctTxs.filter(t => !t.category_id).length;
        const arBtn = document.getElementById('apply-rules-btn');
        if (arBtn) arBtn.textContent = unCatCount > 0 ? `Apply Rules (${unCatCount} uncat.)` : 'Apply Rules';
      } catch (err) {
        toast('Failed to update category: ' + err.message, { kind: 'error' });
      }
    });
  });

  attachSortHandlers(wrap, TX_MOD, () => renderTxTable());
}

// =============================================================================
// SVG charts
// =============================================================================

function drawBalanceChart(txs, L) {
  const wrap = document.getElementById('balance-chart');
  const points = txs.filter(t => t.balance_after != null).map(t => ({
    date: t.date, balance: Number(t.balance_after),
  }));
  if (!points.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="muted">No data yet — upload a statement to see the running balance.</div></div>`;
    return;
  }
  const byDate = new Map();
  for (const p of points) byDate.set(p.date, p);
  const series = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  const W = 900, H = 220, M = { l: 60, r: 20, t: 10, b: 30 };
  const innerW = W - M.l - M.r;
  const innerH = H - M.t - M.b;
  const minB = Math.min(...series.map(p => p.balance), 0);
  const maxB = Math.max(...series.map(p => p.balance));
  const padB = (maxB - minB) * 0.1 || 100;
  const yMin = minB - padB, yMax = maxB + padB;
  const range = (yMax - yMin) || 1;
  const x = (i) => M.l + (innerW * i / Math.max(1, series.length - 1));
  const y = (v) => M.t + innerH * (1 - (v - yMin) / range);
  const path = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.balance).toFixed(1)}`).join(' ');
  const fillPath = path + ` L${x(series.length - 1).toFixed(1)},${(M.t + innerH).toFixed(1)} L${x(0).toFixed(1)},${(M.t + innerH).toFixed(1)} Z`;
  const yTicks = 4;
  const yLabels = Array.from({ length: yTicks + 1 }, (_, i) => {
    const v = yMin + (range * i / yTicks);
    return { v, ypx: y(v) };
  });
  const xTickIdxs = series.length <= 5
    ? series.map((_, i) => i)
    : [0, Math.floor(series.length * 0.25), Math.floor(series.length * 0.5), Math.floor(series.length * 0.75), series.length - 1];
  const dotIdxs = series.length <= 30 ? series.map((_, i) => i) : Array.from({length: 30}, (_, k) => Math.floor(k * (series.length - 1) / 29));

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;font-family:inherit">
      ${yLabels.map(t => `<line x1="${M.l}" y1="${t.ypx}" x2="${M.l + innerW}" y2="${t.ypx}" stroke="var(--hairline)" stroke-width="1"/>`).join('')}
      <path d="${fillPath}" fill="${L.isCredit ? 'var(--red)' : 'var(--gold-soft)'}" opacity="0.3"/>
      <path d="${path}" fill="none" stroke="${L.isCredit ? 'var(--red)' : 'var(--gold)'}" stroke-width="2"/>
      ${dotIdxs.map(i => `<circle cx="${x(i).toFixed(1)}" cy="${y(series[i].balance).toFixed(1)}" r="3" fill="${L.isCredit ? 'var(--red)' : 'var(--gold)'}"><title>${series[i].date}: $${series[i].balance.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2})}</title></circle>`).join('')}
      ${yLabels.map(t => `<text x="${M.l - 8}" y="${t.ypx + 4}" text-anchor="end" font-size="10" fill="var(--ink-500)">$${Math.round(t.v).toLocaleString()}</text>`).join('')}
      ${xTickIdxs.map(i => `<text x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="var(--ink-500)">${shortDate(series[i].date)}</text>`).join('')}
    </svg>
  `;
}

function drawMonthChart(txs, L) {
  const wrap = document.getElementById('month-chart');
  if (!txs.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="muted">No data yet.</div></div>`;
    return;
  }
  const byMonth = new Map();
  for (const t of txs) {
    const m = t.date.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, { deposits: 0, withdrawals: 0 });
    const cell = byMonth.get(m);
    const a = Number(t.amount);
    if (a > 0) cell.deposits += a;
    else cell.withdrawals += a;
  }
  const months = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-12);
  if (!months.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="muted">No data yet.</div></div>`;
    return;
  }
  const W = 900, H = 240, M = { l: 60, r: 20, t: 10, b: 40 };
  const innerW = W - M.l - M.r;
  const innerH = H - M.t - M.b;
  const maxAbs = Math.max(...months.map(([_, v]) => Math.max(v.deposits, Math.abs(v.withdrawals))), 100);
  const yMax = maxAbs * 1.1;
  const yMin = -yMax;
  const range = yMax - yMin;
  const zeroY = M.t + innerH * (yMax / range);
  const groupW = innerW / months.length;
  const barW = Math.min(groupW * 0.35, 24);
  const y = (v) => M.t + innerH * (1 - (v - yMin) / range);

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;font-family:inherit">
      <line x1="${M.l}" y1="${zeroY}" x2="${M.l + innerW}" y2="${zeroY}" stroke="var(--hairline-dark)" stroke-width="1"/>
      <line x1="${M.l}" y1="${M.t}" x2="${M.l + innerW}" y2="${M.t}" stroke="var(--hairline)" stroke-width="1"/>
      <line x1="${M.l}" y1="${M.t + innerH}" x2="${M.l + innerW}" y2="${M.t + innerH}" stroke="var(--hairline)" stroke-width="1"/>
      <text x="${M.l - 8}" y="${M.t + 4}" text-anchor="end" font-size="10" fill="var(--ink-500)">+$${Math.round(yMax).toLocaleString()}</text>
      <text x="${M.l - 8}" y="${zeroY + 4}" text-anchor="end" font-size="10" fill="var(--ink-500)">$0</text>
      <text x="${M.l - 8}" y="${M.t + innerH + 4}" text-anchor="end" font-size="10" fill="var(--ink-500)">-$${Math.round(yMax).toLocaleString()}</text>
      ${months.map(([m, v], i) => {
        const cx = M.l + groupW * i + groupW / 2;
        const depTop = y(v.deposits);
        const depHeight = Math.abs(zeroY - depTop);
        const wHeight = Math.abs(y(v.withdrawals) - zeroY);
        return `
          <rect x="${cx - barW - 1}" y="${depTop}" width="${barW}" height="${depHeight}" fill="var(--green)" opacity="0.85">
            <title>${m} ${L.incomingLbl.toLowerCase()}: $${v.deposits.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2})}</title>
          </rect>
          <rect x="${cx + 1}" y="${zeroY}" width="${barW}" height="${wHeight}" fill="var(--red)" opacity="0.85">
            <title>${m} ${L.outgoingLbl.toLowerCase()}: $${Math.abs(v.withdrawals).toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2})}</title>
          </rect>
          <text x="${cx}" y="${H - 18}" text-anchor="middle" font-size="10" fill="var(--ink-500)">${monthLabel(m)}</text>
          <text x="${cx}" y="${H - 6}" text-anchor="middle" font-size="9" fill="${(v.deposits + v.withdrawals) >= 0 ? 'var(--green)' : 'var(--red)'}" font-weight="600">${(v.deposits + v.withdrawals) >= 0 ? '+' : ''}$${Math.round(v.deposits + v.withdrawals).toLocaleString()}</text>
        `;
      }).join('')}
      <g transform="translate(${M.l + 8}, ${M.t + 12})">
        <rect width="10" height="10" fill="var(--green)" opacity="0.85"/>
        <text x="14" y="9" font-size="10" fill="var(--ink-700)">${L.incomingLbl}</text>
        <rect x="${L.outgoingLbl.length * 6 + 30}" width="10" height="10" fill="var(--red)" opacity="0.85"/>
        <text x="${L.outgoingLbl.length * 6 + 44}" y="9" font-size="10" fill="var(--ink-700)">${L.outgoingLbl}</text>
      </g>
    </svg>
  `;
}

// Spending by category — horizontal bar chart, filterable by date range
function drawCategoryChart() {
  const wrap = document.getElementById('cat-chart');
  if (!wrap) return;
  const acctId = window.__selectedAcctId;
  const accts = window.__bankAccts || [];
  const acct = accts.find(a => a.id === acctId);
  const cats = window.__bankCats || [];
  const txs = (window.__bankTxAll || []).filter(t => t.bank_account_id === acctId);
  const range = document.getElementById('cat-range')?.value || 'ytd';

  // Determine date window
  const sortedDesc = [...txs].sort((a, b) => b.date.localeCompare(a.date));
  const today = new Date();
  let dateFrom = '', dateTo = '9999-99-99';
  if (range === 'latest' && sortedDesc.length) {
    const k = sortedDesc[0].date.slice(0, 7);
    dateFrom = k + '-01';
    dateTo = k + '-31';
  } else if (range === 'lastperiod' && sortedDesc.length) {
    // The latest period's predecessor
    const periods = [...new Set(txs.map(t => t.date.slice(0, 7)))].sort();
    const last = periods[periods.length - 2];
    if (last) { dateFrom = last + '-01'; dateTo = last + '-31'; }
  } else if (range === 'ytd') {
    dateFrom = today.getFullYear() + '-01-01';
  }
  // 'all' = no filter

  const filtered = txs.filter(t => t.date >= dateFrom && t.date <= dateTo);
  // Aggregate spending (negative amounts) by category
  const byCat = new Map();
  let uncat = 0;
  let totalSpend = 0;
  for (const t of filtered) {
    const a = Number(t.amount);
    if (a >= 0) continue; // only spending
    const spend = Math.abs(a);
    totalSpend += spend;
    if (!t.category_id) {
      uncat += spend;
      continue;
    }
    byCat.set(t.category_id, (byCat.get(t.category_id) || 0) + spend);
  }

  const rows = [...byCat.entries()].map(([cid, amt]) => {
    const cat = cats.find(c => c.id === cid);
    return { name: cat?.name || 'Unknown', color: cat?.color || '#888', amount: amt };
  }).sort((a, b) => b.amount - a.amount);

  if (uncat > 0) rows.push({ name: 'Uncategorized', color: '#FFD580', amount: uncat });

  if (!rows.length || totalSpend === 0) {
    wrap.innerHTML = `<div class="empty-state"><div class="muted">No spending in this period.</div></div>`;
    return;
  }

  const max = rows[0].amount;
  const W = 900, rowH = 32, M = { l: 200, r: 100, t: 14, b: 14 };
  const H = M.t + M.b + rowH * rows.length;
  const innerW = W - M.l - M.r;

  wrap.innerHTML = `
    <div style="margin-bottom:8px" class="muted">Total spending: <strong>${fmtMoney(totalSpend)}</strong> across ${rows.length} categor${rows.length === 1 ? 'y' : 'ies'}</div>
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;font-family:inherit">
      ${rows.map((r, i) => {
        const yTop = M.t + i * rowH;
        const barW = (r.amount / max) * innerW;
        const pct = (r.amount / totalSpend * 100).toFixed(1);
        return `
          <text x="${M.l - 10}" y="${yTop + rowH/2 + 4}" text-anchor="end" font-size="12" fill="var(--ink-700)" font-weight="500">${escapeHtml(r.name)}</text>
          <rect x="${M.l}" y="${yTop + 8}" width="${barW.toFixed(1)}" height="${rowH - 16}" fill="${r.color}" rx="3">
            <title>${r.name}: $${r.amount.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2})} (${pct}% of total)</title>
          </rect>
          <text x="${M.l + barW + 6}" y="${yTop + rowH/2 + 4}" font-size="11" fill="var(--ink-700)" font-weight="600">$${Math.round(r.amount).toLocaleString()}</text>
          <text x="${M.l + barW + 6}" y="${yTop + rowH/2 + 17}" font-size="9" fill="var(--ink-500)">${pct}%</text>
        `;
      }).join('')}
    </svg>
  `;
}

function shortDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function monthLabel(ym) {
  const [y, m] = ym.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString('en-US', { month: 'short' }) + " '" + y.slice(2);
}

// =============================================================================
// Apply categorization rules retroactively to all uncategorized tx
// =============================================================================

async function applyRulesRetroactively(acctId, onDone) {
  const rules = window.__bankRules || [];
  if (!rules.length) {
    toast('No rules defined yet. Go to Settings → Categories & Rules to add some.', { kind: 'error', ms: 4000 });
    return;
  }
  const allTx = window.__bankTxAll || [];
  const uncatTx = allTx.filter(t => t.bank_account_id === acctId && !t.category_id);
  if (!uncatTx.length) {
    toast('All transactions already categorized.', { kind: 'success' });
    return;
  }

  // For each uncategorized tx, find first matching rule (priority asc, length desc)
  const updates = [];
  for (const t of uncatTx) {
    const desc = (t.description || '').toLowerCase();
    let match = null;
    for (const r of rules) {
      const m = (r.match_text || '').toLowerCase();
      let isMatch = false;
      if (r.match_type === 'contains') isMatch = desc.includes(m);
      else if (r.match_type === 'starts_with') isMatch = desc.startsWith(m);
      else if (r.match_type === 'exact') isMatch = desc === m;
      if (isMatch) { match = r; break; }  // rules are pre-sorted by priority
    }
    if (match) updates.push({ id: t.id, category_id: match.category_id });
  }

  if (!updates.length) {
    toast(`No rules matched any of the ${uncatTx.length} uncategorized transactions.`, { kind: 'info', ms: 4000 });
    return;
  }

  const ok = await confirmDialog(
    `Apply ${updates.length} categorizations?`,
    `${updates.length} of ${uncatTx.length} uncategorized transactions match an existing rule and will be auto-tagged.`
  );
  if (!ok) return;

  let success = 0, fail = 0;
  for (const u of updates) {
    const { error } = await supabase
      .from('bank_transactions')
      .update({ category_id: u.category_id })
      .eq('id', u.id);
    if (error) fail++; else success++;
  }
  toast(`Applied: ${success} success, ${fail} failed.`, { kind: fail ? 'error' : 'success' });
  onDone && onDone();
}

// =============================================================================
// Account manager
// =============================================================================

function openAccountManager() {
  const accts = window.__bankAccts || [];
  const allTx = window.__bankTxAll || [];
  const txByAcct = new Map();
  for (const t of allTx) {
    if (!txByAcct.has(t.bank_account_id)) txByAcct.set(t.bank_account_id, []);
    txByAcct.get(t.bank_account_id).push(t);
  }
  const liveBal = (a) => {
    const list = txByAcct.get(a.id) || [];
    if (!list.length) return Number(a.current_balance || 0);
    const sorted = [...list].sort((x, y) => y.date.localeCompare(x.date) || (y.created_at || '').localeCompare(x.created_at || ''));
    const withBal = sorted.find(t => t.balance_after != null);
    return withBal ? Number(withBal.balance_after) : Number(a.current_balance || 0);
  };

  modal({
    title: 'Manage Bank Accounts',
    bodyHTML: `
      <div style="margin-bottom:10px"><button class="btn-sm btn-primary" id="add-new-acct" type="button">+ New Account</button></div>
      <table class="data">
        <thead><tr>
          <th>Name</th><th>Type</th><th>Last 4</th><th>Active</th>
          <th class="numeric">Live Balance</th><th></th>
        </tr></thead>
        <tbody>
          ${accts.map(a => `
            <tr>
              <td><strong>${escapeHtml(a.name)}</strong>${a.institution ? `<div class="muted">${escapeHtml(a.institution)}</div>` : ''}</td>
              <td><span class="pill ${a.account_type === 'credit' ? 'pill-gold' : 'pill-gray'}">${(a.account_type || '').toUpperCase()}</span></td>
              <td class="mono">${escapeHtml(a.last4 || '')}</td>
              <td>${a.is_active ? '<span class="pill pill-green">YES</span>' : '<span class="pill pill-red">NO</span>'}</td>
              <td class="numeric">${fmtMoney(liveBal(a))}</td>
              <td><button class="btn-sm btn-ghost edit-acct-btn" data-id="${a.id}" type="button">Edit</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `,
    actions: [{ label: 'Close', kind: 'secondary' }],
  });
  setTimeout(() => {
    document.querySelector('#add-new-acct')?.addEventListener('click', () => {
      document.querySelector('.modal-backdrop')?.remove();
      editAccount(null, () => loadAll());
    });
    document.querySelectorAll('.edit-acct-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const a = (window.__bankAccts || []).find(x => x.id === btn.dataset.id);
        document.querySelector('.modal-backdrop')?.remove();
        editAccount(a, () => loadAll());
      });
    });
  }, 50);
}

function editAccount(record, onDone) {
  const isNew = !record;
  const r = record || { name: '', institution: '', last4: '', account_type: 'checking', current_balance: 0, is_active: true };
  modal({
    title: isNew ? 'New Bank Account' : 'Edit Bank Account',
    bodyHTML: `
      <div class="field"><label class="field-label">Account Name *</label><input class="input" id="f-name" value="${escapeHtml(r.name || '')}"></div>
      <div class="field-row">
        <div class="field"><label class="field-label">Institution</label><input class="input" id="f-inst" value="${escapeHtml(r.institution || '')}"></div>
        <div class="field"><label class="field-label">Type</label>
          <select class="select" id="f-type">
            ${['checking','savings','credit','loc'].map(t => `<option value="${t}" ${t === (r.account_type || 'checking') ? 'selected' : ''}>${t.toUpperCase()}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label class="field-label">Last 4 *</label><input class="input mono" id="f-last4" maxlength="4" value="${escapeHtml(r.last4 || '')}"></div>
        <div class="field"><label class="field-label">Opening Balance</label><input class="input numeric" id="f-bal" type="number" step="0.01" value="${r.current_balance || 0}"></div>
      </div>
      <div class="field" style="display:flex;gap:8px;align-items:center">
        <input type="checkbox" id="f-active" ${r.is_active !== false ? 'checked' : ''}>
        <label for="f-active" class="field-label" style="margin:0">Active</label>
      </div>
      <div class="muted" style="font-size:11px;margin-top:6px">Last 4 is matched against uploaded statements to attach transactions to the right account. For credit cards, choose type "credit".</div>
    `,
    actions: [
      ...(isNew ? [] : [{ label: 'Delete', kind: 'danger', onClick: async () => {
        const ok = await confirmDialog('Delete account?', 'All transactions will lose the link. Confirm?');
        if (!ok) return false;
        try { await q(supabase.from('bank_accounts').delete().eq('id', r.id)); toast('Deleted', { kind: 'success' }); onDone && onDone(); }
        catch (e) { toast('Failed: ' + e.message, { kind: 'error' }); return false; }
      } }]),
      { label: 'Cancel', kind: 'secondary' },
      { label: isNew ? 'Create' : 'Save', kind: 'primary', onClick: async (bg) => {
        const data = {
          name: bg.querySelector('#f-name').value.trim(),
          institution: bg.querySelector('#f-inst').value.trim() || null,
          last4: bg.querySelector('#f-last4').value.trim() || null,
          account_type: bg.querySelector('#f-type').value,
          current_balance: Number(bg.querySelector('#f-bal').value || 0),
          is_active: bg.querySelector('#f-active').checked,
        };
        if (!data.name) { toast('Name is required', { kind: 'error' }); return false; }
        if (!data.last4 || data.last4.length !== 4) { toast('Last 4 digits are required (4 chars)', { kind: 'error' }); return false; }
        try {
          if (isNew) await q(supabase.from('bank_accounts').insert(data));
          else await q(supabase.from('bank_accounts').update(data).eq('id', r.id));
          toast('Saved', { kind: 'success' });
          onDone && onDone();
        } catch (e) { toast('Save failed: ' + e.message, { kind: 'error' }); return false; }
      } },
    ],
  });
}

// CSV import (unchanged from prior)
function importCSV(bankId, onDone) {
  modal({
    title: 'Import Transactions (CSV)',
    bodyHTML: `
      <p class="muted">Paste CSV (Chase or Capital One format auto-detected). Required columns: Date, Description, Amount.</p>
      <div class="field"><textarea class="input mono" id="f-csv" rows="10" style="font-size:11px" placeholder="Date,Description,Amount,Balance"></textarea></div>
    `,
    actions: [
      { label: 'Cancel', kind: 'secondary' },
      { label: 'Import', kind: 'primary', onClick: async (bg) => {
        const csv = bg.querySelector('#f-csv').value.trim();
        if (!csv) { toast('Paste CSV content first', { kind: 'error' }); return false; }
        const rows = parseCSV(csv);
        if (!rows.length) { toast('No data rows parsed', { kind: 'error' }); return false; }
        try {
          const inserts = rows.map(r => ({
            bank_account_id: bankId,
            date: r.date,
            description: r.description.slice(0, 500),
            amount: r.amount,
            balance_after: r.balance,
            reconciled: false,
          }));
          await q(supabase.from('bank_transactions').insert(inserts));
          toast(`Imported ${inserts.length} transactions`, { kind: 'success' });
          onDone && onDone();
        } catch (e) { toast('Import failed: ' + e.message, { kind: 'error' }); return false; }
      } },
    ],
  });
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const head = lines[0].toLowerCase();
  const cols = head.split(',').map(c => c.trim().replace(/"/g, ''));
  const dateIdx = cols.findIndex(c => /(post|trans|date)/i.test(c));
  const descIdx = cols.findIndex(c => /(desc|memo|merchant|payee)/i.test(c));
  const amtIdx = cols.findIndex(c => /amount/i.test(c));
  const balIdx = cols.findIndex(c => /balance/i.test(c));
  if (dateIdx < 0 || descIdx < 0 || amtIdx < 0) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseRow(lines[i]);
    if (!cells || cells.length < Math.max(dateIdx, descIdx, amtIdx) + 1) continue;
    const dateRaw = cells[dateIdx];
    const date = normalizeDate(dateRaw);
    if (!date) continue;
    const amt = Number(String(cells[amtIdx]).replace(/[\$,]/g, '')) || 0;
    out.push({
      date,
      description: (cells[descIdx] || '').replace(/^"|"$/g, ''),
      amount: amt,
      balance: balIdx >= 0 ? (Number(String(cells[balIdx]).replace(/[\$,]/g, '')) || null) : null,
    });
  }
  return out;
}

function parseRow(line) {
  const out = []; let cur = ''; let inq = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inq = !inq; continue; }
    if (c === ',' && !inq) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function normalizeDate(s) {
  if (!s) return null;
  s = s.trim().replace(/^"|"$/g, '');
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    let yr = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${yr}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  }
  return null;
}
