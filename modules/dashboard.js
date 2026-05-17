// =============================================================================
// Dashboard â cash reality, YTD profit/loss, AR/AP aging, charts
// =============================================================================
import { supabase, q } from '../lib/supabase.js';
import { fmtMoney, fmtDate, escapeHtml } from '../lib/format.js';

function getPeriod() {
  return window.__dashPeriod || 'ytd';
}
function setPeriod(p) {
  window.__dashPeriod = p;
}

function periodRange(p) {
  const today = new Date();
  const todayISO = today.toISOString().slice(0, 10);
  if (p === 'ytd') {
    return { start: `${today.getFullYear()}-01-01`, end: todayISO, label: `${today.getFullYear()} YTD` };
  }
  const past = new Date(today);
  past.setFullYear(past.getFullYear() - 1);
  past.setDate(past.getDate() + 1);
  return { start: past.toISOString().slice(0, 10), end: todayISO, label: 'Last 12 Months' };
}

export async function renderDashboard(outlet) {
  outlet.innerHTML = `
    <div class="page-head">
      <div class="page-head-left">
        <h1>DASHBOARD</h1>
        <div class="page-head-sub">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
      </div>
    </div>
    <div id="dash-area"><div class="empty-state"><div class="big">LOADING</div></div></div>
  `;
  await loadAndRender();
}

async function loadAndRender() {
  const area = document.getElementById('dash-area');
  try {
    const [accts, txs, invoices, bills] = await Promise.all([
      q(supabase.from('bank_accounts').select('*').eq('is_active', true)),
      q(supabase.from('bank_transactions').select('id, bank_account_id, date, amount, balance_after, description, category_id, created_at').order('date', { ascending: true })),
      q(supabase.from('invoices').select('id, customer_id, total, amount_paid, status, due_date, voided_at')),
      q(supabase.from('bills').select('id, vendor_id, total, amount_paid, status, due_date, voided_at')),
    ]);
    let cats = [], projects = [];
    try { cats = await q(supabase.from('transaction_categories').select('*')); } catch (e) {}
    try { projects = await q(supabase.from('projects').select('id, status, contract_amount').eq('status', 'active')); } catch (e) {}
    window.__dashData = { accts, txs, invoices, bills, cats, projects };
    paint();
  } catch (e) {
    area.innerHTML = `<div class="empty-state"><div class="big" style="color:var(--red)">ERROR</div><div>${escapeHtml(e.message)}</div></div>`;
  }
}

function paint() {
  const { accts, txs, invoices, bills, cats, projects } = window.__dashData;
  const period = getPeriod();
  const range = periodRange(period);

  const cashAccts = accts.filter(a => a.account_type === 'checking' || a.account_type === 'savings');
  const creditAccts = accts.filter(a => a.account_type === 'credit_card' || a.account_type === 'line_of_credit');
  const cashAcctIds = new Set(cashAccts.map(a => a.id));
  const creditAcctIds = new Set(creditAccts.map(a => a.id));

  function latestBalance(acctId) {
    const list = txs.filter(t => t.bank_account_id === acctId);
    const sorted = [...list].sort((a, b) =>
      b.date.localeCompare(a.date) || (b.created_at || '').localeCompare(a.created_at || '')
    );
    const withBal = sorted.find(t => t.balance_after != null);
    return withBal ? Number(withBal.balance_after) : Number(accts.find(a => a.id === acctId)?.current_balance || 0);
  }
  const cashOnHand = cashAccts.reduce((sum, a) => sum + latestBalance(a.id), 0);
  const creditDebt = creditAccts.reduce((sum, a) => sum + latestBalance(a.id), 0);
  const netPosition = cashOnHand - creditDebt;

  const periodTxs = txs.filter(t => t.date >= range.start && t.date <= range.end);
  let moneyIn = 0, moneyOut = 0;
  for (const t of periodTxs) {
    if (!cashAcctIds.has(t.bank_account_id)) continue;
    const amt = Number(t.amount);
    if (amt > 0) moneyIn += amt;
    else moneyOut += Math.abs(amt);
  }
  const totalCosts = moneyOut + creditDebt;
  const netCashFlow = moneyIn - totalCosts;

  const today = new Date().toISOString().slice(0, 10);
  function bucketize(records) {
    const buckets = { current: 0, b30: 0, b60: 0, b90: 0, b90plus: 0, total: 0, count: 0 };
    for (const r of records) {
      if (r.voided_at || r.status === 'void') continue;
      const open = Number(r.total || 0) - Number(r.amount_paid || 0);
      if (open <= 0.01) continue;
      buckets.total += open;
      buckets.count++;
      if (!r.due_date || r.due_date >= today) {
        buckets.current += open;
      } else {
        const days = Math.floor((new Date(today) - new Date(r.due_date)) / 86400000);
        if (days <= 30) buckets.b30 += open;
        else if (days <= 60) buckets.b60 += open;
        else if (days <= 90) buckets.b90 += open;
        else buckets.b90plus += open;
      }
    }
    return buckets;
  }
  const arAging = bucketize(invoices);
  const apAging = bucketize(bills);

  const sevenDaysOut = new Date(); sevenDaysOut.setDate(sevenDaysOut.getDate() + 7);
  const sevenISO = sevenDaysOut.toISOString().slice(0, 10);
  const dueThisWeek = bills.filter(b => {
    if (b.voided_at || b.status === 'void' || b.status === 'paid') return false;
    if (!b.due_date) return false;
    const open = Number(b.total || 0) - Number(b.amount_paid || 0);
    return open > 0.01 && b.due_date <= sevenISO;
  });
  const dueThisWeekTotal = dueThisWeek.reduce((s, b) => s + (Number(b.total) - Number(b.amount_paid || 0)), 0);

  const activeProjectCount = projects.length;
  const activeProjectValue = projects.reduce((s, p) => s + Number(p.contract_amount || 0), 0);
    // ===== brief_snapshot push — feeds the morning brief =====
    // Fire-and-forget upsert; doesn't block render if it fails.
    try {
      supabase.from('brief_snapshot').upsert({
        id: 'current',
        open_ar: arAging.total,
        open_ar_count: arAging.count,
        ar_current: arAging.current,
        ar_1_30: arAging.b30,
        ar_31_60: arAging.b60,
        ar_61_90: arAging.b90,
        ar_90_plus: arAging.b90plus,
        ar_over_30: arAging.b30 + arAging.b60 + arAging.b90 + arAging.b90plus,
        open_ap: apAging.total,
        due_this_week: dueThisWeekTotal,
        cash_on_hand: cashOnHand,
        credit_debt: creditDebt,
        net_position: netPosition,
        active_contract_value: activeProjectValue,
        active_count: activeProjectCount,
        updated_at: new Date().toISOString(),
      }).then(({ error }) => {
        if (error) console.warn('brief_snapshot push failed:', error.message);
      }).catch(err => console.warn('brief_snapshot push error:', err));
    } catch (e) { /* never block dashboard render */ }
    // ===== end brief_snapshot push =====


  const area = document.getElementById('dash-area');
  area.innerHTML = `
    <div class="summary-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:14px">
      <div class="summary-cell" style="border-top:3px solid var(--green)">
        <div class="muted">CASH ON HAND</div>
        <div class="big">${fmtMoney(cashOnHand)}</div>
        <div class="muted" style="font-size:11px">across ${cashAccts.length} ${cashAccts.length === 1 ? 'account' : 'accounts'}</div>
      </div>
      <div class="summary-cell" style="border-top:3px solid ${creditDebt > 0 ? 'var(--red)' : 'var(--ink-300)'}">
        <div class="muted">CREDIT DEBT</div>
        <div class="big" style="color:${creditDebt > 0 ? 'var(--red)' : 'var(--ink-900)'}">${fmtMoney(creditDebt)}</div>
        <div class="muted" style="font-size:11px">across ${creditAccts.length} ${creditAccts.length === 1 ? 'account' : 'accounts'}</div>
      </div>
      <div class="summary-cell" style="border-top:3px solid ${netPosition >= 0 ? 'var(--green)' : 'var(--red)'}">
        <div class="muted">NET POSITION</div>
        <div class="big" style="color:${netPosition >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtMoney(netPosition)}</div>
        <div class="muted" style="font-size:11px">cash â credit debt</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-header" style="padding:10px 16px;border-bottom:1px solid var(--hairline)">
        <div class="section-title">CASH FLOW PERIOD</div>
        <div style="display:flex;gap:6px">
          <button class="btn-sm ${period === 'ytd' ? 'btn-primary' : 'btn-ghost'}" id="per-ytd">Calendar YTD</button>
          <button class="btn-sm ${period === '12m' ? 'btn-primary' : 'btn-ghost'}" id="per-12m">Last 12 Months</button>
        </div>
      </div>
      <div class="summary-grid" style="grid-template-columns:repeat(3,1fr);padding:0;border:0">
        <div class="summary-cell" style="border-top:0;border-right:1px solid var(--hairline)">
          <div class="muted">MONEY IN Â· ${escapeHtml(range.label).toUpperCase()}</div>
          <div class="big" style="color:var(--green)">${fmtMoney(moneyIn)}</div>
          <div class="muted" style="font-size:11px">deposits to bank account${cashAccts.length > 1 ? 's' : ''}</div>
        </div>
        <div class="summary-cell" style="border-top:0;border-right:1px solid var(--hairline)">
          <div class="muted">MONEY OUT Â· ${escapeHtml(range.label).toUpperCase()}</div>
          <div class="big" style="color:var(--red)">${fmtMoney(totalCosts)}</div>
          <div class="muted" style="font-size:11px">withdrawals ${fmtMoney(moneyOut)} + unpaid credit ${fmtMoney(creditDebt)}</div>
        </div>
        <div class="summary-cell" style="border-top:0">
          <div class="muted">NET CASH FLOW</div>
          <div class="big" style="color:${netCashFlow >= 0 ? 'var(--green)' : 'var(--red)'}">${netCashFlow >= 0 ? '+' : ''}${fmtMoney(netCashFlow)}</div>
          <div class="muted" style="font-size:11px">in â out (true profit ${netCashFlow >= 0 ? 'â' : 'â'})</div>
        </div>
      </div>
    </div>

    <div class="summary-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:14px">
      <div class="summary-cell" style="border-top:3px solid var(--gold)">
        <div class="muted">OPEN AR</div>
        <div class="big">${fmtMoney(arAging.total)}</div>
        <div style="margin-top:8px">${agingBar(arAging)}</div>
        <div class="muted" style="font-size:11px;margin-top:4px">${arAging.count} open invoice${arAging.count === 1 ? '' : 's'}</div>
      </div>
      <div class="summary-cell" style="border-top:3px solid var(--gold)">
        <div class="muted">OPEN AP</div>
        <div class="big">${fmtMoney(apAging.total)}</div>
        <div style="margin-top:8px">${agingBar(apAging)}</div>
        <div class="muted" style="font-size:11px;margin-top:4px">${apAging.count} open bill${apAging.count === 1 ? '' : 's'}</div>
      </div>
      <div class="summary-cell" style="border-top:3px solid ${dueThisWeek.length > 0 ? 'var(--red)' : 'var(--ink-300)'}">
        <div class="muted">DUE THIS WEEK</div>
        <div class="big" style="color:${dueThisWeek.length > 0 ? 'var(--red)' : 'var(--ink-900)'}">${fmtMoney(dueThisWeekTotal)}</div>
        <div class="muted" style="font-size:11px">${dueThisWeek.length === 0 ? 'Nothing due in next 7 days' : `${dueThisWeek.length} bill${dueThisWeek.length === 1 ? '' : 's'} due`}</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:3fr 2fr;gap:14px;margin-bottom:14px">
      <div class="card">
        <div class="card-header">
          <div class="section-title">CASH & DEBT Â· ${escapeHtml(range.label).toUpperCase()}</div>
          <div class="muted" style="font-size:11px">Live balances over time</div>
        </div>
        <div id="cashflow-chart"></div>
      </div>
      <div class="card">
        <div class="card-header">
          <div class="section-title">TOP SPENDING Â· ${escapeHtml(range.label).toUpperCase()}</div>
          <div class="muted" style="font-size:11px">Credit card categories</div>
        </div>
        <div id="spending-chart"></div>
      </div>
    </div>

    <div class="summary-grid" style="grid-template-columns:1fr;margin-bottom:14px">
      <div class="summary-cell" style="border-top:3px solid var(--ink-700)">
        <div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap">
          <div>
            <div class="muted">ACTIVE PROJECTS</div>
            <div class="big">${activeProjectCount}</div>
          </div>
          <div style="border-left:1px solid var(--hairline);padding-left:24px">
            <div class="muted">TOTAL CONTRACT VALUE</div>
            <div class="big">${fmtMoney(activeProjectValue)}</div>
          </div>
          <div class="muted" style="font-size:11px;margin-left:auto;max-width:300px;text-align:right">
            Detailed project margins are tracked in the Takeoff app where labor + materials + equipment are reflected accurately.
          </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('per-ytd').onclick = () => { setPeriod('ytd'); paint(); };
  document.getElementById('per-12m').onclick = () => { setPeriod('12m'); paint(); };

  drawCashFlowChart(periodTxs, range, cashAcctIds, creditAcctIds);
  drawSpendingChart(periodTxs, cats, creditAcctIds);
}

function agingBar(b) {
  if (b.total <= 0) return '<div class="muted" style="font-size:11px">No open balances</div>';
  const segs = [
    { key: 'current', val: b.current, color: 'var(--green)', label: 'Current' },
    { key: 'b30',     val: b.b30,     color: '#FBBF24',      label: '1-30' },
    { key: 'b60',     val: b.b60,     color: '#F97316',      label: '31-60' },
    { key: 'b90',     val: b.b90,     color: '#EF4444',      label: '61-90' },
    { key: 'b90plus', val: b.b90plus, color: '#991B1B',      label: '90+' },
  ];
  const bar = `<div style="display:flex;height:8px;border-radius:3px;overflow:hidden;background:var(--ink-50)">
    ${segs.map(s => s.val > 0
      ? `<div style="background:${s.color};width:${(s.val / b.total * 100).toFixed(2)}%" title="${s.label}: ${fmtMoney(s.val)}"></div>`
      : '').join('')}
  </div>`;
  const labels = `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;font-size:10px;color:var(--ink-500)">
    ${segs.filter(s => s.val > 0).map(s => `<span><span style="color:${s.color}">â</span> ${s.label}: ${fmtMoney(s.val)}</span>`).join('')}
  </div>`;
  return bar + labels;
}

function drawCashFlowChart(periodTxs, range, cashAcctIds, creditAcctIds) {
  const wrap = document.getElementById('cashflow-chart');
  const allDates = new Set();
  for (const t of periodTxs) allDates.add(t.date);
  if (!allDates.size) {
    wrap.innerHTML = '<div class="empty-state"><div class="muted">No transactions in this period.</div></div>';
    return;
  }
  const sortedDates = [...allDates].sort();

  function buildSeries(acctIds) {
    const perAcctLatest = new Map();
    const seriesMap = new Map();
    const earlierTxs = (window.__dashData.txs || []).filter(t => t.date < range.start && t.balance_after != null && acctIds.has(t.bank_account_id));
    for (const t of earlierTxs) {
      const cur = perAcctLatest.get(t.bank_account_id);
      if (!cur || t.date >= cur.date) perAcctLatest.set(t.bank_account_id, { date: t.date, bal: Number(t.balance_after) });
    }
    for (const [k, v] of perAcctLatest) perAcctLatest.set(k, v.bal || 0);
    function totalNow() {
      let s = 0;
      for (const v of perAcctLatest.values()) s += v;
      return s;
    }
    for (const d of sortedDates) {
      const dayTxs = periodTxs.filter(t => t.date === d && acctIds.has(t.bank_account_id) && t.balance_after != null);
      const byAcct = new Map();
      for (const t of dayTxs) {
        const cur = byAcct.get(t.bank_account_id);
        if (!cur || (t.created_at || '').localeCompare(cur.created_at || '') > 0) byAcct.set(t.bank_account_id, t);
      }
      for (const [acctId, t] of byAcct) perAcctLatest.set(acctId, Number(t.balance_after));
      seriesMap.set(d, totalNow());
    }
    return seriesMap;
  }
  const cashSeries = buildSeries(cashAcctIds);
  const debtSeries = buildSeries(creditAcctIds);

  const dates = sortedDates;
  const cashVals = dates.map(d => cashSeries.get(d) ?? 0);
  const debtVals = dates.map(d => debtSeries.get(d) ?? 0);

  const W = 900, H = 240, M = { l: 60, r: 20, t: 10, b: 30 };
  const innerW = W - M.l - M.r;
  const innerH = H - M.t - M.b;
  const allVals = [...cashVals, ...debtVals];
  const minV = Math.min(0, ...allVals);
  const maxV = Math.max(...allVals);
  const padV = (maxV - minV) * 0.1 || 100;
  const yMin = minV - padV;
  const yMax = maxV + padV;
  const rng = (yMax - yMin) || 1;
  const x = i => M.l + (innerW * i / Math.max(1, dates.length - 1));
  const y = v => M.t + innerH * (1 - (v - yMin) / rng);
  const cashPath = cashVals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const debtPath = debtVals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  const yTicks = 4;
  const yLabels = Array.from({ length: yTicks + 1 }, (_, i) => {
    const v = yMin + (rng * i / yTicks);
    return { v, ypx: y(v) };
  });
  const xTickIdxs = dates.length <= 5
    ? dates.map((_, i) => i)
    : [0, Math.floor(dates.length * 0.25), Math.floor(dates.length * 0.5), Math.floor(dates.length * 0.75), dates.length - 1];

  function shortDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;font-family:inherit">
      ${yLabels.map(t => `<line x1="${M.l}" y1="${t.ypx}" x2="${M.l + innerW}" y2="${t.ypx}" stroke="var(--hairline)" stroke-width="1"/>`).join('')}
      ${cashVals.length ? `<path d="${cashPath}" fill="none" stroke="#3B82F6" stroke-width="2"/>` : ''}
      ${debtVals.length ? `<path d="${debtPath}" fill="none" stroke="#EF4444" stroke-width="2"/>` : ''}
      ${yLabels.map(t => `<text x="${M.l - 8}" y="${t.ypx + 4}" text-anchor="end" font-size="10" fill="var(--ink-500)">$${Math.round(t.v).toLocaleString()}</text>`).join('')}
      ${xTickIdxs.map(i => `<text x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="var(--ink-500)">${shortDate(dates[i])}</text>`).join('')}
      <g transform="translate(${M.l + 10}, ${M.t + 12})">
        <rect width="10" height="10" fill="#3B82F6"/>
        <text x="14" y="9" font-size="10" fill="var(--ink-700)">Cash on hand</text>
        <rect x="100" width="10" height="10" fill="#EF4444"/>
        <text x="114" y="9" font-size="10" fill="var(--ink-700)">Credit debt</text>
      </g>
    </svg>
  `;
}

function drawSpendingChart(periodTxs, cats, creditAcctIds) {
  const wrap = document.getElementById('spending-chart');
  if (!cats || !cats.length) {
    wrap.innerHTML = '<div class="empty-state"><div class="muted">No categories defined.</div></div>';
    return;
  }
  const ccOutflows = periodTxs.filter(t => creditAcctIds.has(t.bank_account_id) && Number(t.amount) < 0);
  if (!ccOutflows.length) {
    wrap.innerHTML = '<div class="empty-state"><div class="muted">No credit card spending in this period.</div></div>';
    return;
  }
  const catMap = new Map(cats.map(c => [c.id, c]));
  const byCat = new Map();
  let uncatTotal = 0;
  for (const t of ccOutflows) {
    const amt = Math.abs(Number(t.amount));
    const c = catMap.get(t.category_id);
    if (!c) { uncatTotal += amt; continue; }
    if (c.name === 'Payments') continue;
    byCat.set(c.id, (byCat.get(c.id) || 0) + amt);
  }
  const rows = [...byCat.entries()].map(([id, amt]) => {
    const c = catMap.get(id);
    return { name: c.name, color: c.color || '#888', amount: amt };
  }).sort((a, b) => b.amount - a.amount).slice(0, 6);
  if (uncatTotal > 0 && rows.length < 7) {
    rows.push({ name: 'Uncategorized', color: '#CCCCCC', amount: uncatTotal });
  }
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty-state"><div class="muted">No categorized spending in this period.</div></div>';
    return;
  }
  const totalSpend = rows.reduce((s, r) => s + r.amount, 0);
  const maxAmt = Math.max(...rows.map(r => r.amount));

  wrap.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:6px;padding:8px 0">
      <div class="muted" style="font-size:11px;margin-bottom:4px">Total: <strong>${fmtMoney(totalSpend)}</strong> (top ${rows.length})</div>
      ${rows.map(r => {
        const widthPct = maxAmt > 0 ? (r.amount / maxAmt * 100) : 0;
        return `
          <div style="display:grid;grid-template-columns:120px 1fr 80px;gap:6px;align-items:center;font-size:12px">
            <div style="display:flex;align-items:center;gap:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span style="display:inline-block;width:8px;height:8px;background:${r.color};border-radius:2px;flex-shrink:0"></span><span style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(r.name)}</span></div>
            <div style="background:var(--ink-50);height:14px;border-radius:3px;overflow:hidden">
              <div style="background:${r.color};height:100%;width:${widthPct.toFixed(1)}%;opacity:0.85"></div>
            </div>
            <div class="numeric mono" style="font-weight:600;font-size:11px">${fmtMoney(r.amount)}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}
