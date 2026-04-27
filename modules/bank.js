// =============================================================================
// Bank — Per-account dashboard with KPIs, charts, and full tx explorer
// -----------------------------------------------------------------------------
// Layout (per selected account):
//   1. Account picker + meta (last4, type, period covered)
//   2. KPI band: Current Balance · This Month Deposits · This Month Withdrawals · Net
//   3. Running-balance line chart (full history)
//   4. Monthly deposits-vs-withdrawals bar chart (last 12 months)
//   5. Filterable, sortable transaction table with date range + statement batch trace
// =============================================================================
import { supabase, q } from '../lib/supabase.js';
import { fmtMoney, fmtDate, fmtDateISO, escapeHtml } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { confirmDialog, modal } from '../lib/modal.js';
import { sortRows, headerHTML, attachSortHandlers, getSortState } from '../lib/sort.js';

const TX_MOD = 'bank_tx';

const TX_COLUMNS = [
  { key: 'date',          label: 'Date',        type: 'date' },
  { key: 'description',   label: 'Description', type: 'string' },
  { key: 'amount',        label: 'Amount',      type: 'number', numeric: true },
  { key: 'balance_after', label: 'Balance',     type: 'number', numeric: true },
  { key: 'reconciled',    label: 'Reconciled',  type: 'number', get: r => r.reconciled ? 1 : 0 },
];

export async function renderBank(outlet) {
  outlet.innerHTML = `
    <div class="page-head">
      <div class="page-head-left">
        <h1>BANK</h1>
        <div class="page-head-sub">Cash dashboard per account</div>
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
    const [accts, allTx] = await Promise.all([
      q(supabase.from('bank_accounts').select('*').eq('is_active', true).order('name')),
      q(supabase.from('bank_transactions').select('*').order('date', { ascending: true })),
    ]);
    if (!accts.length) {
      area.innerHTML = `<div class="empty-state"><div class="big">NO ACCOUNTS</div><div>Click "Manage Accounts" to add your first one.</div></div>`;
      return;
    }
    window.__bankAccts = accts;
    window.__bankTxAll = allTx;
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
  const acctId = window.__selectedAcctId;
  const acct = accts.find(a => a.id === acctId);
  const txs = allTx.filter(t => t.bank_account_id === acctId);

  // Compute the live current balance: most recent transaction's balance_after.
  // If none, fall back to acct.current_balance.
  const sortedDesc = [...txs].sort((a, b) => b.date.localeCompare(a.date) || (b.created_at || '').localeCompare(a.created_at || ''));
  const liveBalance = sortedDesc.length && sortedDesc[0].balance_after != null
    ? Number(sortedDesc[0].balance_after)
    : Number(acct?.current_balance || 0);

  // This month aggregates
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  let mDeposits = 0, mWithdrawals = 0;
  for (const t of txs) {
    if (t.date < monthStart) continue;
    const a = Number(t.amount);
    if (a > 0) mDeposits += a;
    else mWithdrawals += a;
  }
  const mNet = mDeposits + mWithdrawals;

  // If we have any tx, find period of the most recent statement batch
  const lastBatchId = sortedDesc.length ? sortedDesc[0].import_batch_id : null;
  const lastBatchTx = lastBatchId ? txs.filter(t => t.import_batch_id === lastBatchId) : [];
  const batchStart = lastBatchTx.length ? lastBatchTx.reduce((m, t) => t.date < m ? t.date : m, lastBatchTx[0].date) : null;
  const batchEnd = lastBatchTx.length ? lastBatchTx.reduce((m, t) => t.date > m ? t.date : m, lastBatchTx[0].date) : null;

  // Active statement window (default to current month, but track via window state)
  const acctOpts = accts.map(a => `<option value="${a.id}" ${a.id === acctId ? 'selected' : ''}>${escapeHtml(a.name)} ····${a.last4 || '—'}</option>`).join('');

  document.getElementById('bank-area').innerHTML = `
    <!-- Account picker -->
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <div>
          <div class="muted" style="font-size:11px;letter-spacing:0.5px;text-transform:uppercase">Account</div>
          <select id="acct-picker" class="select" style="min-width:280px;font-size:14px;font-weight:600">${acctOpts}</select>
        </div>
        <div style="border-left:1px solid var(--hairline);padding-left:14px">
          <div class="muted" style="font-size:11px;letter-spacing:0.5px;text-transform:uppercase">Type</div>
          <div style="font-weight:600">${escapeHtml((acct?.account_type || '').toUpperCase())}</div>
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
          <button class="btn-sm btn-ghost" id="import-csv-btn">Import CSV</button>
        </div>
      </div>
    </div>

    <!-- KPI band -->
    <div class="summary-grid" style="margin-bottom:14px">
      <div class="summary-cell">
        <div class="muted">CURRENT BALANCE</div>
        <div class="big">${fmtMoney(liveBalance)}</div>
        <div class="muted" style="font-size:11px">${sortedDesc.length ? `as of ${fmtDate(sortedDesc[0].date)}` : 'no transactions yet'}</div>
      </div>
      <div class="summary-cell">
        <div class="muted">THIS MONTH DEPOSITS</div>
        <div class="big" style="color:var(--green)">${fmtMoney(mDeposits)}</div>
        <div class="muted" style="font-size:11px">since ${fmtDate(monthStart)}</div>
      </div>
      <div class="summary-cell">
        <div class="muted">THIS MONTH WITHDRAWALS</div>
        <div class="big" style="color:var(--red)">${fmtMoney(Math.abs(mWithdrawals))}</div>
        <div class="muted" style="font-size:11px">since ${fmtDate(monthStart)}</div>
      </div>
      <div class="summary-cell">
        <div class="muted">NET CHANGE</div>
        <div class="big" style="color:${mNet >= 0 ? 'var(--green)' : 'var(--red)'}">${mNet >= 0 ? '+' : ''}${fmtMoney(mNet)}</div>
        <div class="muted" style="font-size:11px">this month</div>
      </div>
      <div class="summary-cell">
        <div class="muted">TRANSACTIONS</div>
        <div class="big">${txs.length}</div>
        <div class="muted" style="font-size:11px">total on file</div>
      </div>
    </div>

    <!-- Charts row -->
    <div class="card" style="margin-bottom:14px">
      <div class="card-header">
        <div class="section-title">RUNNING BALANCE</div>
        <div class="muted" style="font-size:11px">Daily balance over time</div>
      </div>
      <div id="balance-chart"></div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-header">
        <div class="section-title">DEPOSITS VS WITHDRAWALS BY MONTH</div>
        <div class="muted" style="font-size:11px">Last 12 months</div>
      </div>
      <div id="month-chart"></div>
    </div>

    <!-- Transaction explorer -->
    <div class="card">
      <div class="card-header">
        <div class="section-title">TRANSACTIONS</div>
      </div>
      <div class="toolbar">
        <input type="search" id="tx-search" placeholder="Search description…" class="input" style="max-width:280px">
        <label class="muted" style="font-size:11px">From</label>
        <input class="input" id="tx-from" type="date" style="max-width:160px">
        <label class="muted" style="font-size:11px">To</label>
        <input class="input" id="tx-to" type="date" style="max-width:160px">
        <select id="tx-type" class="select" style="max-width:160px">
          <option value="">All types</option>
          <option value="deposits">Deposits only</option>
          <option value="withdrawals">Withdrawals only</option>
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

  // Wire up account picker
  document.getElementById('acct-picker').onchange = (e) => {
    window.__selectedAcctId = e.target.value;
    renderDashboard();
  };
  document.getElementById('import-csv-btn').onclick = () => importCSV(acctId, () => loadAll());

  // Render charts (SVG)
  drawBalanceChart(txs);
  drawMonthChart(txs);

  // Render filterable tx table
  document.getElementById('tx-search').oninput = renderTxTable;
  document.getElementById('tx-from').onchange = renderTxTable;
  document.getElementById('tx-to').onchange = renderTxTable;
  document.getElementById('tx-type').onchange = renderTxTable;
  document.getElementById('tx-recon').onchange = renderTxTable;
  document.getElementById('tx-clear-filters').onclick = () => {
    ['tx-search','tx-from','tx-to'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('tx-type').value = '';
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
  const recon = document.getElementById('tx-recon')?.value || '';

  if (term) txs = txs.filter(t => (t.description || '').toLowerCase().includes(term));
  if (from) txs = txs.filter(t => t.date >= from);
  if (to) txs = txs.filter(t => t.date <= to);
  if (type === 'deposits') txs = txs.filter(t => Number(t.amount) > 0);
  if (type === 'withdrawals') txs = txs.filter(t => Number(t.amount) < 0);
  if (recon === 'reconciled') txs = txs.filter(t => t.reconciled);
  if (recon === 'unreconciled') txs = txs.filter(t => !t.reconciled);

  const wrap = document.getElementById('tx-table-wrap');
  if (!txs.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="muted">No transactions match your filters.</div></div>`;
    return;
  }

  // Footer totals based on filtered rows
  const totals = txs.reduce((acc, t) => {
    const a = Number(t.amount);
    if (a > 0) acc.deposits += a;
    else acc.withdrawals += a;
    return acc;
  }, { deposits: 0, withdrawals: 0 });

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
          <td colspan="2"></td>
        </tr>
      </tfoot>
    </table>
  `;
  attachSortHandlers(wrap, TX_MOD, () => renderTxTable());
}

// =============================================================================
// SVG charts (no library deps)
// =============================================================================

function drawBalanceChart(txs) {
  const wrap = document.getElementById('balance-chart');
  const points = txs.filter(t => t.balance_after != null).map(t => ({
    date: t.date,
    balance: Number(t.balance_after),
  }));
  if (!points.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="muted">No data yet — upload a statement to see the running balance.</div></div>`;
    return;
  }
  // De-dupe by date (keep last entry per day)
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

  // Y-axis labels at 4 levels
  const yTicks = 4;
  const yLabels = Array.from({ length: yTicks + 1 }, (_, i) => {
    const v = yMin + (range * i / yTicks);
    return { v, ypx: y(v) };
  });

  // X-axis labels: first, ~3 middles, last
  const xTickIdxs = series.length <= 5
    ? series.map((_, i) => i)
    : [0, Math.floor(series.length * 0.25), Math.floor(series.length * 0.5), Math.floor(series.length * 0.75), series.length - 1];

  // Hover dots (last 12)
  const dotIdxs = series.length <= 30 ? series.map((_, i) => i) : Array.from({length: 30}, (_, k) => Math.floor(k * (series.length - 1) / 29));

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;font-family:inherit">
      <!-- gridlines -->
      ${yLabels.map(t => `<line x1="${M.l}" y1="${t.ypx}" x2="${M.l + innerW}" y2="${t.ypx}" stroke="var(--hairline)" stroke-width="1"/>`).join('')}
      <!-- area fill -->
      <path d="${fillPath}" fill="var(--gold-soft)" opacity="0.4"/>
      <!-- line -->
      <path d="${path}" fill="none" stroke="var(--gold)" stroke-width="2"/>
      <!-- dots -->
      ${dotIdxs.map(i => `<circle cx="${x(i).toFixed(1)}" cy="${y(series[i].balance).toFixed(1)}" r="3" fill="var(--gold)"><title>${series[i].date}: $${series[i].balance.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2})}</title></circle>`).join('')}
      <!-- y labels -->
      ${yLabels.map(t => `<text x="${M.l - 8}" y="${t.ypx + 4}" text-anchor="end" font-size="10" fill="var(--ink-500)">$${Math.round(t.v).toLocaleString()}</text>`).join('')}
      <!-- x labels -->
      ${xTickIdxs.map(i => `<text x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="var(--ink-500)">${shortDate(series[i].date)}</text>`).join('')}
    </svg>
  `;
}

function drawMonthChart(txs) {
  const wrap = document.getElementById('month-chart');
  if (!txs.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="muted">No data yet.</div></div>`;
    return;
  }
  // Aggregate by YYYY-MM
  const byMonth = new Map();
  for (const t of txs) {
    const m = t.date.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, { deposits: 0, withdrawals: 0 });
    const cell = byMonth.get(m);
    const a = Number(t.amount);
    if (a > 0) cell.deposits += a;
    else cell.withdrawals += a;
  }
  // Sort and keep last 12 months
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
      <!-- zero line -->
      <line x1="${M.l}" y1="${zeroY}" x2="${M.l + innerW}" y2="${zeroY}" stroke="var(--hairline-dark)" stroke-width="1"/>
      <!-- y gridlines (max + min) -->
      <line x1="${M.l}" y1="${M.t}" x2="${M.l + innerW}" y2="${M.t}" stroke="var(--hairline)" stroke-width="1"/>
      <line x1="${M.l}" y1="${M.t + innerH}" x2="${M.l + innerW}" y2="${M.t + innerH}" stroke="var(--hairline)" stroke-width="1"/>
      <text x="${M.l - 8}" y="${M.t + 4}" text-anchor="end" font-size="10" fill="var(--ink-500)">+$${Math.round(yMax).toLocaleString()}</text>
      <text x="${M.l - 8}" y="${zeroY + 4}" text-anchor="end" font-size="10" fill="var(--ink-500)">$0</text>
      <text x="${M.l - 8}" y="${M.t + innerH + 4}" text-anchor="end" font-size="10" fill="var(--ink-500)">-$${Math.round(yMax).toLocaleString()}</text>
      ${months.map(([m, v], i) => {
        const cx = M.l + groupW * i + groupW / 2;
        const depTop = y(v.deposits);
        const depHeight = Math.abs(zeroY - depTop);
        const wTop = zeroY;
        const wHeight = Math.abs(y(v.withdrawals) - zeroY);
        const wActualTop = y(v.withdrawals);
        return `
          <!-- deposit bar (above zero) -->
          <rect x="${cx - barW - 1}" y="${depTop}" width="${barW}" height="${depHeight}" fill="var(--green)" opacity="0.85">
            <title>${m} deposits: $${v.deposits.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2})}</title>
          </rect>
          <!-- withdrawal bar (below zero) -->
          <rect x="${cx + 1}" y="${zeroY}" width="${barW}" height="${wHeight}" fill="var(--red)" opacity="0.85">
            <title>${m} withdrawals: $${Math.abs(v.withdrawals).toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2})}</title>
          </rect>
          <text x="${cx}" y="${H - 18}" text-anchor="middle" font-size="10" fill="var(--ink-500)">${monthLabel(m)}</text>
          <text x="${cx}" y="${H - 6}" text-anchor="middle" font-size="9" fill="${(v.deposits + v.withdrawals) >= 0 ? 'var(--green)' : 'var(--red)'}" font-weight="600">${(v.deposits + v.withdrawals) >= 0 ? '+' : ''}$${Math.round(v.deposits + v.withdrawals).toLocaleString()}</text>
        `;
      }).join('')}
      <!-- legend -->
      <g transform="translate(${M.l + 8}, ${M.t + 12})">
        <rect width="10" height="10" fill="var(--green)" opacity="0.85"/>
        <text x="14" y="9" font-size="10" fill="var(--ink-700)">Deposits</text>
        <rect x="80" width="10" height="10" fill="var(--red)" opacity="0.85"/>
        <text x="94" y="9" font-size="10" fill="var(--ink-700)">Withdrawals</text>
      </g>
    </svg>
  `;
}

function shortDate(iso) {
  // "2026-01-15" → "Jan 15"
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function monthLabel(ym) {
  // "2026-01" → "Jan '26"
  const [y, m] = ym.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString('en-US', { month: 'short' }) + ' \'' + y.slice(2);
}

// =============================================================================
// Account manager (replaces the old account-list page)
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
    const latest = list.reduce((m, t) =>
      (t.date > m.date || (t.date === m.date && (t.created_at || '') > (m.created_at || ''))) ? t : m, list[0]);
    return latest.balance_after != null ? Number(latest.balance_after) : Number(a.current_balance || 0);
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
              <td><span class="pill pill-gray">${(a.account_type || '').toUpperCase()}</span></td>
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
      // Close current modal first
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
      <div class="muted" style="font-size:11px;margin-top:6px">Last 4 is matched against uploaded bank statements to attach transactions to the right account.</div>
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

// =============================================================================
// CSV import (kept from prior version — same parser, just wired to new entry)
// =============================================================================

function importCSV(bankId, onDone) {
  modal({
    title: 'Import Transactions (CSV)',
    bodyHTML: `
      <p class="muted">Paste CSV (Chase or Capital One format auto-detected). Required columns: Date, Description, Amount.</p>
      <div class="field"><textarea class="input mono" id="f-csv" rows="10" style="font-size:11px" placeholder="Date,Description,Amount,Balance"></textarea></div>
      <div id="parse-status" class="muted" style="margin-top:8px"></div>
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
  const out = [];
  let cur = '';
  let inq = false;
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
