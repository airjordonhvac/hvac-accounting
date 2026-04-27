// =============================================================================
// Bank — Per-account dashboard
// -----------------------------------------------------------------------------
// Behavior depends on account_type:
//   - checking / savings: clean cash-flow dashboard (deposits, withdrawals, net)
//     with no categorization UI
//   - credit_card / line_of_credit: credit-aware dashboard
//     (amount owed, charges, payments) with category column on transactions
//     and "Spending by Category" chart
// =============================================================================
import { supabase, q } from '../lib/supabase.js';
import { fmtMoney, fmtDate, fmtDateISO, escapeHtml } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { confirmDialog, modal } from '../lib/modal.js';
import { sortRows, headerHTML, attachSortHandlers, getSortState } from '../lib/sort.js';

const TX_MOD = 'bank_tx';

// Credit-style accounts: credit cards and lines of credit. These get
// categorization, "amount owed" language, and the spending-by-category chart.
function isCreditStyle(acct) {
  const t = acct?.account_type;
  return t === 'credit_card' || t === 'line_of_credit';
}

function creditLang() {
  return {
    balanceLabel:    'AMOUNT OWED',
    depositsLabel:   'PAYMENTS MADE',
    withdrawalsLabel:'CHARGES',
    netLabel:        'NET CHANGE',
    txTitle:         'TRANSACTIONS',
    monthChartTitle: 'CHARGES VS PAYMENTS',
    depShortLbl:     'Payments',
    wdShortLbl:      'Charges',
  };
}

function bankLang() {
  return {
    balanceLabel:    'CURRENT BALANCE',
    depositsLabel:   'DEPOSITS',
    withdrawalsLabel:'WITHDRAWALS',
    netLabel:        'NET CHANGE',
    txTitle:         'TRANSACTIONS',
    monthChartTitle: 'DEPOSITS VS WITHDRAWALS',
    depShortLbl:     'Deposits',
    wdShortLbl:      'Withdrawals',
  };
}

const TX_COLUMNS_BANK = [
  { key: 'date',          label: 'Date',        type: 'date' },
  { key: 'description',   label: 'Description', type: 'string' },
  { key: 'amount',        label: 'Amount',      type: 'number', numeric: true },
  { key: 'balance_after', label: 'Balance',     type: 'number', numeric: true },
  { key: 'reconciled',    label: 'Reconciled',  type: 'number', get: r => r.reconciled ? 1 : 0 },
];

const TX_COLUMNS_CREDIT = [
  { key: 'date',          label: 'Date',        type: 'date' },
  { key: 'description',   label: 'Description', type: 'string' },
  { key: 'category_name', label: 'Category',    type: 'string', get: r => r._categoryName || '' },
  { key: 'amount',        label: 'Amount',      type: 'number', numeric: true },
  { key: 'balance_after', label: 'Balance',     type: 'number', numeric: true },
  { key: 'reconciled',    label: 'Reconciled',  type: 'number', get: r => r.reconciled ? 1 : 0 },
];

function fmtAccountType(t) {
  return (t || '').replace('_', ' ').toUpperCase();
}

export async function renderBank(outlet) {
  outlet.innerHTML = `
    <div class="page-head">
      <div class="page-head-left">
        <h1>BANK</h1>
        <div class="page-head-sub">Cash dashboard per account</div>
      </div>
      <div class="page-head-right">
        <button class="btn-secondary" id="apply-rules-btn" style="display:none">Apply Rules to All</button>
        <button class="btn-secondary" id="manage-accts">Manage Accounts</button>
      </div>
    </div>
    <div id="bank-area"><div class="empty-state"><div class="big">LOADING</div></div></div>
  `;
  document.getElementById('manage-accts').onclick = () => openAccountManager();
  document.getElementById('apply-rules-btn').onclick = () => applyRulesToAll();
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
    for (const t of allTx) {
      const cat = catMap.get(t.category_id);
      t._categoryName = cat?.name || '';
      t._categoryColor = cat?.color || null;
    }
    window.__bankAccts = accts;
    window.__bankTxAll = allTx;
    window.__bankCats = cats;
    window.__bankRules = rules;
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
  const allTx = window.__bankTxAll || [];
  const cats = window.__bankCats || [];
  const acctId = window.__selectedAcctId;
  const acct = accts.find(a => a.id === acctId);
  const credit = isCreditStyle(acct);
  const L = credit ? creditLang() : bankLang();
  const txs = allTx.filter(t => t.bank_account_id === acctId);

  const applyBtn = document.getElementById('apply-rules-btn');
  if (applyBtn) applyBtn.style.display = credit ? '' : 'none';

  const sortedDesc = [...txs].sort((a, b) =>
    b.date.localeCompare(a.date) || (b.created_at || '').localeCompare(a.created_at || '')
  );
  const latestWithBalance = sortedDesc.find(t => t.balance_after != null);
  const liveBalance = latestWithBalance
    ? Number(latestWithBalance.balance_after)
    : Number(acct?.current_balance || 0);
  const balanceAsOfDate = latestWithBalance ? latestWithBalance.date : (sortedDesc[0]?.date || null);

  let mDeposits = 0, mWithdrawals = 0;
  let latestPeriodLabel = '';
  let latestPeriodKey = '';
  if (sortedDesc.length) {
    latestPeriodKey = sortedDesc[0].date.slice(0, 7);
    const periodStart = latestPeriodKey + '-01';
    const periodEnd = latestPeriodKey + '-31';
    for (const t of txs) {
      if (t.date < periodStart || t.date > periodEnd) continue;
      const a = Number(t.amount);
      if (a > 0) mDeposits += a;
      else mWithdrawals += a;
    }
    const d = new Date(periodStart + 'T00:00:00');
    latestPeriodLabel = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  const mNet = mDeposits + mWithdrawals;

  const lastBatchId = sortedDesc.length ? sortedDesc[0].import_batch_id : null;
  const lastBatchTx = lastBatchId ? txs.filter(t => t.import_batch_id === lastBatchId) : [];
  const batchStart = lastBatchTx.length ? lastBatchTx.reduce((m, t) => t.date < m ? t.date : m, lastBatchTx[0].date) : null;
  const batchEnd = lastBatchTx.length ? lastBatchTx.reduce((m, t) => t.date > m ? t.date : m, lastBatchTx[0].date) : null;

  const uncatCount = credit ? txs.filter(t => !t.category_id).length : 0;

  const acctOpts = accts.map(a => {
    const tag = isCreditStyle(a) ? '💳' : '🏦';
    return `<option value="${a.id}" ${a.id === acctId ? 'selected' : ''}>${tag} ${escapeHtml(a.name)} ····${a.last4 || '—'}</option>`;
  }).join('');

  document.getElementById('bank-area').innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <div>
          <div class="muted" style="font-size:11px;letter-spacing:0.5px;text-transform:uppercase">Account</div>
          <select id="acct-picker" class="select" style="min-width:300px;font-size:14px;font-weight:600">${acctOpts}</select>
        </div>
        <div style="border-left:1px solid var(--hairline);padding-left:14px">
          <div class="muted" style="font-size:11px;letter-spacing:0.5px;text-transform:uppercase">Type</div>
          <div style="font-weight:600">${escapeHtml(fmtAccountType(acct?.account_type))}${credit ? ' 💳' : ''}</div>
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
        ${uncatCount > 0 ? `
        <div style="border-left:1px solid var(--hairline);padding-left:14px">
          <div class="muted" style="font-size:11px;letter-spacing:0.5px;text-transform:uppercase">Needs Category</div>
          <div style="font-weight:600;color:var(--amber)">${uncatCount} tx</div>
        </div>` : ''}
        <div style="margin-left:auto;display:flex;gap:8px">
          <button class="btn-sm btn-ghost" id="import-csv-btn">Import CSV</button>
        </div>
      </div>
    </div>

    <div class="summary-grid" style="margin-bottom:14px">
      <div class="summary-cell">
        <div class="muted">${L.balanceLabel}</div>
        <div class="big" style="${credit && liveBalance > 0 ? 'color:var(--red)' : ''}">${fmtMoney(liveBalance)}</div>
        <div class="muted" style="font-size:11px">${balanceAsOfDate ? `as of ${fmtDate(balanceAsOfDate)}` : 'no transactions yet'}</div>
      </div>
      <div class="summary-cell">
        <div class="muted">${L.depositsLabel}</div>
        <div class="big" style="color:var(--green)">${fmtMoney(mDeposits)}</div>
        <div class="muted" style="font-size:11px">${latestPeriodLabel || 'no data'}</div>
      </div>
      <div class="summary-cell">
        <div class="muted">${L.withdrawalsLabel}</div>
        <div class="big" style="color:var(--red)">${fmtMoney(Math.abs(mWithdrawals))}</div>
        <div class="muted" style="font-size:11px">${latestPeriodLabel || 'no data'}</div>
      </div>
      <div class="summary-cell">
        <div class="muted">${L.netLabel}</div>
        <div class="big" style="color:${mNet >= 0 ? 'var(--green)' : 'var(--red)'}">${mNet >= 0 ? '+' : ''}${fmtMoney(mNet)}</div>
        <div class="muted" style="font-size:11px">${latestPeriodLabel ? `for ${latestPeriodLabel}` : 'no data'}</div>
      </div>
      <div class="summary-cell">
        <div class="muted">TRANSACTIONS</div>
        <div class="big">${txs.length}</div>
        <div class="muted" style="font-size:11px">total on file</div>
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
        <div class="section-title">${L.monthChartTitle} BY MONTH</div>
        <div class="muted" style="font-size:11px">Last 12 months</div>
      </div>
      <div id="month-chart"></div>
    </div>

    ${credit ? `
    <div class="card" style="margin-bottom:14px">
      <div class="card-header">
        <div class="section-title">SPENDING BY CATEGORY</div>
        <div style="display:flex;gap:8px;align-items:center">
          <select id="cat-range" class="select" style="font-size:11px;padding:4px 8px">
            <option value="ytd" selected>Year to date</option>
            <option value="month">Latest month</option>
            <option value="quarter">Last 3 months</option>
            <option value="all">All time</option>
          </select>
        </div>
      </div>
      <div id="category-chart"></div>
    </div>
    ` : ''}

    <div class="card">
      <div class="card-header">
        <div class="section-title">${L.txTitle}</div>
      </div>
      <div class="toolbar">
        <input type="search" id="tx-search" placeholder="Search description…" class="input" style="max-width:280px">
        <label class="muted" style="font-size:11px">From</label>
        <input class="input" id="tx-from" type="date" style="max-width:160px">
        <label class="muted" style="font-size:11px">To</label>
        <input class="input" id="tx-to" type="date" style="max-width:160px">
        <select id="tx-type" class="select" style="max-width:160px">
          <option value="">All types</option>
          <option value="deposits">${credit ? 'Payments only' : 'Deposits only'}</option>
          <option value="withdrawals">${credit ? 'Charges only' : 'Withdrawals only'}</option>
        </select>
        ${credit ? `
        <select id="tx-cat" class="select" style="max-width:200px">
          <option value="">All categories</option>
          <option value="__uncat">Uncategorized only</option>
          ${cats.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
        </select>` : ''}
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
  if (credit) {
    document.getElementById('cat-range').onchange = () => drawCategoryChart(txs);
  }

  drawBalanceChart(txs);
  drawMonthChart(txs, credit);
  if (credit) drawCategoryChart(txs);

  document.getElementById('tx-search').oninput = renderTxTable;
  document.getElementById('tx-from').onchange = renderTxTable;
  document.getElementById('tx-to').onchange = renderTxTable;
  document.getElementById('tx-type').onchange = renderTxTable;
  if (credit) document.getElementById('tx-cat').onchange = renderTxTable;
  document.getElementById('tx-recon').onchange = renderTxTable;
  document.getElementById('tx-clear-filters').onclick = () => {
    ['tx-search','tx-from','tx-to'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('tx-type').value = '';
    if (credit) document.getElementById('tx-cat').value = '';
    document.getElementById('tx-recon').value = '';
    renderTxTable();
  };
  renderTxTable();
}

function renderTxTable() {
  const acctId = window.__selectedAcctId;
  const accts = window.__bankAccts || [];
  const acct = accts.find(a => a.id === acctId);
  const credit = isCreditStyle(acct);
  const allTx = window.__bankTxAll || [];
  const cats = window.__bankCats || [];
  let txs = allTx.filter(t => t.bank_account_id === acctId);

  const term = (document.getElementById('tx-search')?.value || '').trim().toLowerCase();
  const from = document.getElementById('tx-from')?.value || '';
  const to = document.getElementById('tx-to')?.value || '';
  const type = document.getElementById('tx-type')?.value || '';
  const cat = credit ? (document.getElementById('tx-cat')?.value || '') : '';
  const recon = document.getElementById('tx-recon')?.value || '';

  if (term) txs = txs.filter(t => (t.description || '').toLowerCase().includes(term));
  if (from) txs = txs.filter(t => t.date >= from);
  if (to) txs = txs.filter(t => t.date <= to);
  if (type === 'deposits') txs = txs.filter(t => Number(t.amount) > 0);
  if (type === 'withdrawals') txs = txs.filter(t => Number(t.amount) < 0);
  if (cat === '__uncat') txs = txs.filter(t => !t.category_id);
  else if (cat) txs = txs.filter(t => t.category_id === cat);
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

  const COLUMNS = credit ? TX_COLUMNS_CREDIT : TX_COLUMNS_BANK;
  const state = getSortState(TX_MOD, { key: 'date', dir: 'desc' });
  const sorted = sortRows(txs, COLUMNS, state);

  const catOpts = (selectedId) => `
    <option value="">— Uncategorized —</option>
    ${cats.map(c => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
  `;

  wrap.innerHTML = `
    <table class="data">
      <thead><tr>${headerHTML(COLUMNS, state)}</tr></thead>
      <tbody>
        ${sorted.map(t => `
          <tr data-tx-id="${t.id}">
            <td>${fmtDate(t.date)}</td>
            <td>${escapeHtml(t.description || '')}</td>
            ${credit ? `<td>
              <select class="select cat-picker" data-tx-id="${t.id}" style="font-size:11px;padding:3px 6px;${t._categoryColor ? `border-left:3px solid ${t._categoryColor}` : ''}">${catOpts(t.category_id)}</select>
            </td>` : ''}
            <td class="numeric ${Number(t.amount) < 0 ? 'delta-down' : 'delta-up'}">${fmtMoney(t.amount)}</td>
            <td class="numeric">${t.balance_after != null ? fmtMoney(t.balance_after) : '<span class="muted">—</span>'}</td>
            <td>${t.reconciled ? '<span class="pill pill-green">YES</span>' : '<span class="pill pill-amber">PENDING</span>'}</td>
          </tr>
        `).join('')}
      </tbody>
      <tfoot>
        <tr style="font-weight:600;background:var(--ink-50)">
          <td colspan="${credit ? 3 : 2}"><strong>${txs.length} transactions</strong></td>
          <td class="numeric">
            <div class="delta-up">+${fmtMoney(totals.deposits)}</div>
            <div class="delta-down">${fmtMoney(totals.withdrawals)}</div>
            <div style="border-top:1px solid var(--hairline);margin-top:2px;padding-top:2px">
              <strong>${(totals.deposits + totals.withdrawals) >= 0 ? '+' : ''}${fmtMoney(totals.deposits + totals.withdrawals)}</strong>
            </div>
          </td>
          <td colspan="2"></td>
        </tr>
      </tfoot>
    </table>
  `;
  attachSortHandlers(wrap, TX_MOD, () => renderTxTable());

  if (credit) {
    wrap.querySelectorAll('.cat-picker').forEach(sel => {
      sel.onchange = async (e) => {
        const txId = e.target.dataset.txId;
        const newCatId = e.target.value || null;
        try {
          await q(supabase.from('bank_transactions').update({ category_id: newCatId }).eq('id', txId));
          const tx = (window.__bankTxAll || []).find(t => t.id === txId);
          if (tx) {
            tx.category_id = newCatId;
            const c = (window.__bankCats || []).find(x => x.id === newCatId);
            tx._categoryName = c?.name || '';
            tx._categoryColor = c?.color || null;
            if (c) e.target.style.borderLeft = `3px solid ${c.color}`;
            else e.target.style.borderLeft = '';
          }
          const acctTxs = (window.__bankTxAll || []).filter(t => t.bank_account_id === window.__selectedAcctId);
          drawCategoryChart(acctTxs);
          toast('Category saved', { kind: 'success', ms: 1500 });
        } catch (err) {
          toast('Save failed: ' + err.message, { kind: 'error' });
        }
      };
    });
  }
}

function drawBalanceChart(txs) {
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
      <path d="${fillPath}" fill="var(--gold-soft)" opacity="0.4"/>
      <path d="${path}" fill="none" stroke="var(--gold)" stroke-width="2"/>
      ${dotIdxs.map(i => `<circle cx="${x(i).toFixed(1)}" cy="${y(series[i].balance).toFixed(1)}" r="3" fill="var(--gold)"><title>${series[i].date}: $${series[i].balance.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2})}</title></circle>`).join('')}
      ${yLabels.map(t => `<text x="${M.l - 8}" y="${t.ypx + 4}" text-anchor="end" font-size="10" fill="var(--ink-500)">$${Math.round(t.v).toLocaleString()}</text>`).join('')}
      ${xTickIdxs.map(i => `<text x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="var(--ink-500)">${shortDate(series[i].date)}</text>`).join('')}
    </svg>
  `;
}

function drawMonthChart(txs, credit) {
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
  const depLbl = credit ? 'Payments' : 'Deposits';
  const wdLbl = credit ? 'Charges' : 'Withdrawals';

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
            <title>${m} ${depLbl.toLowerCase()}: $${v.deposits.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2})}</title>
          </rect>
          <rect x="${cx + 1}" y="${zeroY}" width="${barW}" height="${wHeight}" fill="var(--red)" opacity="0.85">
            <title>${m} ${wdLbl.toLowerCase()}: $${Math.abs(v.withdrawals).toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2})}</title>
          </rect>
          <text x="${cx}" y="${H - 18}" text-anchor="middle" font-size="10" fill="var(--ink-500)">${monthLabel(m)}</text>
          <text x="${cx}" y="${H - 6}" text-anchor="middle" font-size="9" fill="${(v.deposits + v.withdrawals) >= 0 ? 'var(--green)' : 'var(--red)'}" font-weight="600">${(v.deposits + v.withdrawals) >= 0 ? '+' : ''}$${Math.round(v.deposits + v.withdrawals).toLocaleString()}</text>
        `;
      }).join('')}
      <g transform="translate(${M.l + 8}, ${M.t + 12})">
        <rect width="10" height="10" fill="var(--green)" opacity="0.85"/>
        <text x="14" y="9" font-size="10" fill="var(--ink-700)">${depLbl}</text>
        <rect x="80" width="10" height="10" fill="var(--red)" opacity="0.85"/>
        <text x="94" y="9" font-size="10" fill="var(--ink-700)">${wdLbl}</text>
      </g>
    </svg>
  `;
}

function drawCategoryChart(txs) {
  const wrap = document.getElementById('category-chart');
  if (!wrap) return;
  const cats = window.__bankCats || [];
  const range = document.getElementById('cat-range')?.value || 'ytd';

  const today = new Date();
  let startDate = null;
  if (range === 'ytd') {
    startDate = `${today.getFullYear()}-01-01`;
  } else if (range === 'month') {
    const sorted = [...txs].sort((a, b) => b.date.localeCompare(a.date));
    if (sorted.length) startDate = sorted[0].date.slice(0, 7) + '-01';
  } else if (range === 'quarter') {
    const d = new Date();
    d.setMonth(d.getMonth() - 3);
    startDate = fmtDateISO(d);
  }

  let filtered = txs;
  if (startDate) filtered = txs.filter(t => t.date >= startDate);
  filtered = filtered.filter(t => Number(t.amount) < 0);

  if (!filtered.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="muted">No spending transactions in this period.</div></div>`;
    return;
  }

  const byCat = new Map();
  let uncat = 0;
  for (const t of filtered) {
    const amt = Math.abs(Number(t.amount));
    if (!t.category_id) {
      uncat += amt;
      continue;
    }
    byCat.set(t.category_id, (byCat.get(t.category_id) || 0) + amt);
  }

  const rows = [...byCat.entries()].map(([catId, amt]) => {
    const c = cats.find(c => c.id === catId);
    return { name: c?.name || 'Unknown', color: c?.color || '#888', amount: amt };
  }).sort((a, b) => b.amount - a.amount);

  if (uncat > 0) {
    rows.push({ name: 'Uncategorized', color: '#CCCCCC', amount: uncat });
  }

  const totalSpend = rows.reduce((s, r) => s + r.amount, 0);
  const maxAmt = Math.max(...rows.map(r => r.amount));

  wrap.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px;padding:8px 0">
      <div class="muted" style="font-size:11px;margin-bottom:4px">Total spending: <strong>${fmtMoney(totalSpend)}</strong> across ${rows.length} ${rows.length === 1 ? 'category' : 'categories'}</div>
      ${rows.map(r => {
        const pct = totalSpend > 0 ? (r.amount / totalSpend * 100) : 0;
        const widthPct = maxAmt > 0 ? (r.amount / maxAmt * 100) : 0;
        return `
          <div style="display:grid;grid-template-columns:180px 1fr 100px 60px;gap:10px;align-items:center;font-size:13px">
            <div style="display:flex;align-items:center;gap:6px"><span style="display:inline-block;width:10px;height:10px;background:${r.color};border-radius:2px"></span>${escapeHtml(r.name)}</div>
            <div style="background:var(--ink-50);height:18px;border-radius:3px;overflow:hidden;position:relative">
              <div style="background:${r.color};height:100%;width:${widthPct.toFixed(1)}%;opacity:0.85"></div>
            </div>
            <div class="numeric mono" style="font-weight:600">${fmtMoney(r.amount)}</div>
            <div class="muted" style="font-size:11px;text-align:right">${pct.toFixed(1)}%</div>
          </div>
        `;
      }).join('')}
    </div>
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

async function applyRulesToAll() {
  const ok = await confirmDialog(
    'Apply categorization rules?',
    'This will run all active rules against transactions on credit card and line of credit accounts and update categories where a rule matches. Existing categorizations will be overwritten if a rule matches.'
  );
  if (!ok) return;
  try {
    toast('Applying rules…', { ms: 2000 });
    const [rules, txs, accts] = await Promise.all([
      q(supabase.from('categorization_rules').select('*').eq('is_active', true).order('priority')),
      q(supabase.from('bank_transactions').select('id, description, category_id, bank_account_id')),
      q(supabase.from('bank_accounts').select('id, account_type')),
    ]);
    if (!rules.length) {
      toast('No rules defined yet. Add some in Settings → Auto-Categorization Rules.', { kind: 'error', ms: 4000 });
      return;
    }
    const creditAcctIds = new Set(accts.filter(a => a.account_type === 'credit_card' || a.account_type === 'line_of_credit').map(a => a.id));
    let updated = 0;
    for (const tx of txs) {
      if (!creditAcctIds.has(tx.bank_account_id)) continue;
      const desc = (tx.description || '').toLowerCase();
      let matched = null;
      for (const r of rules) {
        const m = (r.match_text || '').toLowerCase();
        if (!m) continue;
        let hit = false;
        if (r.match_type === 'contains') hit = desc.includes(m);
        else if (r.match_type === 'starts_with') hit = desc.startsWith(m);
        else if (r.match_type === 'exact') hit = desc === m;
        if (hit) { matched = r.category_id; break; }
      }
      if (matched && matched !== tx.category_id) {
        await supabase.from('bank_transactions').update({ category_id: matched }).eq('id', tx.id);
        updated++;
      }
    }
    toast(`Done. Updated ${updated} transactions.`, { kind: 'success', ms: 4000 });
    loadAll();
  } catch (e) {
    toast('Failed: ' + e.message, { kind: 'error' });
  }
}

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
    title: 'Manage Accounts',
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
              <td>${isCreditStyle(a) ? '💳 ' : '🏦 '}<strong>${escapeHtml(a.name)}</strong>${a.institution ? `<div class="muted">${escapeHtml(a.institution)}</div>` : ''}</td>
              <td><span class="pill pill-gray">${escapeHtml(fmtAccountType(a.account_type))}</span></td>
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
    title: isNew ? 'New Account' : 'Edit Account',
    bodyHTML: `
      <div class="field"><label class="field-label">Account Name *</label><input class="input" id="f-name" value="${escapeHtml(r.name || '')}"></div>
      <div class="field-row">
        <div class="field"><label class="field-label">Institution *</label><input class="input" id="f-inst" value="${escapeHtml(r.institution || '')}"></div>
        <div class="field"><label class="field-label">Type</label>
          <select class="select" id="f-type">
            ${[
              ['checking','CHECKING'],
              ['savings','SAVINGS'],
              ['credit_card','CREDIT CARD'],
              ['line_of_credit','LINE OF CREDIT'],
            ].map(([v,lbl]) => `<option value="${v}" ${v === (r.account_type || 'checking') ? 'selected' : ''}>${lbl}</option>`).join('')}
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
      <div class="muted" style="font-size:11px;margin-top:6px">For credit cards or lines of credit, set type to CREDIT CARD or LINE OF CREDIT — the dashboard flips language to AMOUNT OWED, CHARGES, PAYMENTS and adds category tracking. Last 4 is matched against uploaded statements.</div>
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
        if (!data.institution) { toast('Institution is required', { kind: 'error' }); return false; }
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
