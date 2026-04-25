// =============================================================================
// Dashboard
// -----------------------------------------------------------------------------
// Six cards + cash flow sparkline. All numbers are live queries against
// Supabase (no caching — these are small queries and accountants want the
// freshest number).
//
// Cards:
//   1. Total AR          - sum(invoices.total - amount_paid) where status != void
//   2. AR > 30 days      - same but filtered by due_date >= 31 days ago
//   3. Total AP          - sum(bills.total - amount_paid) where status != void
//   4. AP due this week  - same but filtered by due_date <= today + 7
//   5. Cash position     - sum(bank_accounts.current_balance) where is_active
//   6. 1099 vendors YTD  - count of vendors in v_1099_vendor_year with >= $600
//
// Cash flow sparkline: daily net of payments (received - sent) for last 90 days.
// =============================================================================

import { supabase } from '../lib/supabase.js';
import { fmtMoney, fmtDateShort } from '../lib/format.js';

export async function renderDashboard(outlet) {
  outlet.innerHTML = `
    <div class="page-head">
      <div class="page-head-left">
        <h1>DASHBOARD</h1>
        <div class="page-head-sub">${todayLabel()}</div>
      </div>
    </div>

    <div class="card-grid">
      ${statCard('ar', 'Total AR',           'accent-gold')}
      ${statCard('ar30', 'AR > 30 Days',     'accent-red')}
      ${statCard('ap', 'Total AP',           'accent-gold')}
      ${statCard('ap7', 'AP Due This Week',  'accent-red')}
      ${statCard('cash', 'Cash Position',    'accent-green')}
      ${statCard('ten99', '1099 Vendors YTD')}
    </div>

    <div class="card-grid">
      <div class="cashflow-card">
        <div class="cashflow-head">
          <h3>CASH FLOW · LAST 90 DAYS</h3>
          <div class="stat-meta" id="cf-summary">&nbsp;</div>
        </div>
        <svg id="cf-chart" class="cashflow-chart" viewBox="0 0 800 120" preserveAspectRatio="none"></svg>
      </div>
    </div>
  `;

  // Fire all queries in parallel
  const tasks = [
    loadAR(),
    loadAR30(),
    loadAP(),
    loadAP7(),
    loadCash(),
    load1099(),
    loadCashFlow(),
  ];
  await Promise.all(tasks);
}

// ------- Card helpers -------

function statCard(id, label, accent = '') {
  return `
    <div class="stat-card ${accent}">
      <div class="stat-label">${label}</div>
      <div class="stat-value" id="card-${id}-value">—</div>
      <div class="stat-meta" id="card-${id}-meta">&nbsp;</div>
    </div>`;
}

function setCard(id, value, meta) {
  const v = document.getElementById(`card-${id}-value`);
  const m = document.getElementById(`card-${id}-meta`);
  if (v) v.textContent = value;
  if (m) m.innerHTML = meta || '&nbsp;';
}

function todayLabel() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

// ------- Queries -------

async function loadAR() {
  // Sum of (total - amount_paid) across non-void invoices.
  const { data, error } = await supabase
    .from('invoices')
    .select('total, amount_paid, status')
    .neq('status', 'void')
    .neq('status', 'draft');  // draft invoices aren't "AR" yet
  if (error) return setCard('ar', 'ERR', error.message);
  const open = (data || []).reduce((s, r) => s + (Number(r.total) - Number(r.amount_paid)), 0);
  const count = (data || []).filter(r => Number(r.total) > Number(r.amount_paid)).length;
  setCard('ar', fmtMoney(open), `${count} open invoice${count === 1 ? '' : 's'}`);
}

async function loadAR30() {
  // Invoices with due_date >= 31 days past, outstanding balance.
  const cutoff = daysAgoISO(31);
  const { data, error } = await supabase
    .from('invoices')
    .select('total, amount_paid, due_date, status')
    .neq('status', 'void')
    .neq('status', 'draft')
    .lte('due_date', cutoff);
  if (error) return setCard('ar30', 'ERR', error.message);
  const past = (data || []).reduce((s, r) => s + (Number(r.total) - Number(r.amount_paid)), 0);
  const count = (data || []).filter(r => Number(r.total) > Number(r.amount_paid)).length;
  setCard('ar30', fmtMoney(past), count > 0 ? `<span class="delta-down">${count} past due</span>` : 'All current');
}

async function loadAP() {
  const { data, error } = await supabase
    .from('bills')
    .select('total, amount_paid, status')
    .neq('status', 'void');
  if (error) return setCard('ap', 'ERR', error.message);
  const open = (data || []).reduce((s, r) => s + (Number(r.total) - Number(r.amount_paid)), 0);
  const count = (data || []).filter(r => Number(r.total) > Number(r.amount_paid)).length;
  setCard('ap', fmtMoney(open), `${count} open bill${count === 1 ? '' : 's'}`);
}

async function loadAP7() {
  // Bills due within 7 days.
  const todayISO = new Date().toISOString().slice(0, 10);
  const weekISO = daysAheadISO(7);
  const { data, error } = await supabase
    .from('bills')
    .select('total, amount_paid, due_date, status')
    .neq('status', 'void')
    .gte('due_date', todayISO)
    .lte('due_date', weekISO);
  if (error) return setCard('ap7', 'ERR', error.message);
  const due = (data || []).reduce((s, r) => s + (Number(r.total) - Number(r.amount_paid)), 0);
  const count = (data || []).length;
  setCard('ap7', fmtMoney(due), count > 0 ? `${count} bill${count === 1 ? '' : 's'} due` : 'Nothing due');
}

async function loadCash() {
  // Sum across active checking/savings accounts only.
  // Credit cards and lines of credit are liabilities — not part of "cash on hand."
  const { data, error } = await supabase
    .from('bank_accounts')
    .select('current_balance, account_type, is_active, name')
    .eq('is_active', true)
    .in('account_type', ['checking', 'savings']);
  if (error) return setCard('cash', 'ERR', error.message);
  const total = (data || []).reduce((s, r) => s + Number(r.current_balance), 0);
  const count = (data || []).length;
  setCard('cash', fmtMoney(total), count === 0 ? 'No bank accounts' : `Across ${count} account${count === 1 ? '' : 's'}`);
}

async function load1099() {
  const year = new Date().getFullYear();
  // Aggregate per vendor from v_1099_vendor_year
  const { data, error } = await supabase
    .from('v_1099_vendor_year')
    .select('vendor_id, total_paid')
    .eq('tax_year', year);
  if (error) return setCard('ten99', 'ERR', error.message);

  // Sum per vendor (across payment methods), count those >= $600
  const byVendor = new Map();
  (data || []).forEach(r => {
    byVendor.set(r.vendor_id, (byVendor.get(r.vendor_id) || 0) + Number(r.total_paid));
  });
  const qualifying = [...byVendor.values()].filter(t => t >= 600).length;
  const totalVendors = byVendor.size;
  setCard('ten99', String(qualifying), `of ${totalVendors} 1099 vendor${totalVendors === 1 ? '' : 's'} · ${year}`);
}

async function loadCashFlow() {
  // Daily net payment flow over the last 90 days.
  const startISO = daysAgoISO(90);
  const { data, error } = await supabase
    .from('payments')
    .select('date, amount, direction')
    .gte('date', startISO)
    .order('date');
  if (error) {
    drawSparklineError(error.message);
    return;
  }

  // Bucket by date
  const buckets = new Map();
  for (let i = 0; i <= 90; i++) {
    buckets.set(daysAgoISO(90 - i), 0);
  }
  (data || []).forEach(p => {
    const signed = p.direction === 'received' ? Number(p.amount) : -Number(p.amount);
    if (buckets.has(p.date)) buckets.set(p.date, buckets.get(p.date) + signed);
  });

  const series = [...buckets.entries()].map(([date, val]) => ({ date, val }));
  drawSparkline(series);

  const totalIn = (data || []).filter(p => p.direction === 'received').reduce((s, p) => s + Number(p.amount), 0);
  const totalOut = (data || []).filter(p => p.direction === 'sent').reduce((s, p) => s + Number(p.amount), 0);
  const net = totalIn - totalOut;
  const summary = document.getElementById('cf-summary');
  if (summary) {
    summary.innerHTML = `
      In ${fmtMoney(totalIn)} · Out ${fmtMoney(totalOut)} ·
      Net <span class="${net >= 0 ? 'delta-up' : 'delta-down'}">${fmtMoney(net)}</span>`;
  }
}

// ------- Sparkline drawing -------

function drawSparkline(series) {
  const svg = document.getElementById('cf-chart');
  if (!svg) return;
  svg.innerHTML = '';

  const W = 800, H = 120;
  const padX = 10, padY = 10;
  const plotW = W - padX * 2;
  const plotH = H - padY * 2;

  // Compute cumulative balance (running sum of daily nets), which is the
  // more meaningful line than raw daily net — gives the shape of cash position
  // drift over the window.
  let cum = 0;
  const pts = series.map((p, i) => {
    cum += p.val;
    return { x: i, y: cum, date: p.date };
  });

  const ys = pts.map(p => p.y);
  const yMin = Math.min(...ys, 0);
  const yMax = Math.max(...ys, 0);
  const yRange = (yMax - yMin) || 1;

  const x = (i) => padX + (i / (pts.length - 1)) * plotW;
  const y = (val) => padY + plotH - ((val - yMin) / yRange) * plotH;

  // Zero line
  const zeroY = y(0);
  const zeroLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  zeroLine.setAttribute('x1', padX);
  zeroLine.setAttribute('x2', W - padX);
  zeroLine.setAttribute('y1', zeroY);
  zeroLine.setAttribute('y2', zeroY);
  zeroLine.setAttribute('stroke', 'var(--ink-200)');
  zeroLine.setAttribute('stroke-dasharray', '3 3');
  svg.appendChild(zeroLine);

  // Area fill
  const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const areaPath = `M ${x(0)} ${zeroY} ` +
    pts.map(p => `L ${x(p.x)} ${y(p.y)}`).join(' ') +
    ` L ${x(pts.length - 1)} ${zeroY} Z`;
  area.setAttribute('d', areaPath);
  area.setAttribute('fill', 'var(--sky)');
  area.setAttribute('opacity', '0.15');
  svg.appendChild(area);

  // Line
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.x)} ${y(p.y)}`).join(' ');
  line.setAttribute('d', linePath);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'var(--sky)');
  line.setAttribute('stroke-width', '2');
  line.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(line);

  // End dot
  const last = pts[pts.length - 1];
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', x(last.x));
  dot.setAttribute('cy', y(last.y));
  dot.setAttribute('r', '4');
  dot.setAttribute('fill', 'var(--gold)');
  dot.setAttribute('stroke', 'white');
  dot.setAttribute('stroke-width', '2');
  svg.appendChild(dot);

  // Start/end date labels (small)
  const startLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  startLabel.setAttribute('x', padX);
  startLabel.setAttribute('y', H - 2);
  startLabel.setAttribute('font-size', '10');
  startLabel.setAttribute('fill', 'var(--ink-400)');
  startLabel.setAttribute('font-family', 'JetBrains Mono, monospace');
  startLabel.textContent = fmtDateShort(pts[0].date);
  svg.appendChild(startLabel);

  const endLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  endLabel.setAttribute('x', W - padX);
  endLabel.setAttribute('y', H - 2);
  endLabel.setAttribute('text-anchor', 'end');
  endLabel.setAttribute('font-size', '10');
  endLabel.setAttribute('fill', 'var(--ink-400)');
  endLabel.setAttribute('font-family', 'JetBrains Mono, monospace');
  endLabel.textContent = fmtDateShort(last.date);
  svg.appendChild(endLabel);
}

function drawSparklineError(msg) {
  const svg = document.getElementById('cf-chart');
  if (!svg) return;
  svg.innerHTML = `<text x="400" y="60" text-anchor="middle" fill="var(--ink-400)" font-size="12">${msg}</text>`;
}

// ------- Date helpers -------

function daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
function daysAheadISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
