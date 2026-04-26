// =============================================================================
// Reports — P&L (cash basis), AR/AP aging, project P&L, CSV export
// =============================================================================
import { supabase, q } from '../lib/supabase.js';
import { fmtMoney, fmtDate, fmtDateISO, daysPastDue, escapeHtml } from '../lib/format.js';
import { toast } from '../lib/toast.js';

export async function renderReports(outlet) {
  const today = new Date();
  const yStart = `${today.getFullYear()}-01-01`;
  const yEnd = fmtDateISO(today);
  outlet.innerHTML = `
    <div class="page-head">
      <div class="page-head-left">
        <h1>REPORTS</h1>
        <div class="page-head-sub">P&amp;L, AR/AP aging, project costing</div>
      </div>
    </div>
    <div class="toolbar">
      <select id="rep-pick" class="select" style="max-width:240px">
        <option value="pnl">Profit &amp; Loss (cash basis)</option>
        <option value="ar">AR Aging Detail</option>
        <option value="ap">AP Aging Detail</option>
        <option value="proj">Project P&amp;L</option>
        <option value="cash">Cash Activity</option>
      </select>
      <input class="input" id="rep-from" type="date" value="${yStart}">
      <input class="input" id="rep-to" type="date" value="${yEnd}">
      <button class="btn-primary" id="rep-run">Run</button>
      <button class="btn-sm btn-ghost" id="rep-csv">Export CSV</button>
    </div>
    <div id="rep-out"><div class="empty-state"><div class="muted">Select a report and click Run.</div></div></div>
  `;
  document.getElementById('rep-run').onclick = run;
  document.getElementById('rep-csv').onclick = exportCSV;
}

async function run() {
  const kind = document.getElementById('rep-pick').value;
  const from = document.getElementById('rep-from').value;
  const to = document.getElementById('rep-to').value;
  const out = document.getElementById('rep-out');
  out.innerHTML = `<div class="empty-state"><div class="big">RUNNING</div></div>`;
  try {
    if (kind === 'pnl') await runPnL(from, to, out);
    else if (kind === 'ar') await runAR(out);
    else if (kind === 'ap') await runAP(out);
    else if (kind === 'proj') await runProjectPnL(out);
    else if (kind === 'cash') await runCash(from, to, out);
  } catch (e) {
    out.innerHTML = `<div class="empty-state"><div style="color:var(--red)">${escapeHtml(e.message)}</div></div>`;
  }
}

async function runPnL(from, to, out) {
  // Cash-basis: revenue from received payments applied to invoices,
  // expenses from sent payments applied to bills (mapped to expense accounts via lines).
  const [payments, applications, invoices, bills, billLines, invoiceLines, accounts] = await Promise.all([
    q(supabase.from('payments').select('*').gte('date', from).lte('date', to)),
    q(supabase.from('payment_applications').select('*')),
    q(supabase.from('invoices').select('id, total')),
    q(supabase.from('bills').select('id, total')),
    q(supabase.from('bill_lines').select('bill_id, amount, expense_account_id')),
    q(supabase.from('invoice_lines').select('invoice_id, amount, revenue_account_id')),
    q(supabase.from('chart_of_accounts').select('id, account_number, name, type')),
  ]);
  const acctMap = new Map(accounts.map(a => [a.id, a]));
  const inv = new Map(invoices.map(i => [i.id, i]));
  const bil = new Map(bills.map(b => [b.id, b]));
  const invLineMap = new Map();
  for (const l of invoiceLines) {
    if (!invLineMap.has(l.invoice_id)) invLineMap.set(l.invoice_id, []);
    invLineMap.get(l.invoice_id).push(l);
  }
  const billLineMap = new Map();
  for (const l of billLines) {
    if (!billLineMap.has(l.bill_id)) billLineMap.set(l.bill_id, []);
    billLineMap.get(l.bill_id).push(l);
  }
  const payIds = new Set(payments.map(p => p.id));
  const inApps = applications.filter(a => payIds.has(a.payment_id) && a.invoice_id);
  const outApps = applications.filter(a => payIds.has(a.payment_id) && a.bill_id);
  // Revenue by account
  const revByAcct = new Map();
  for (const a of inApps) {
    const lines = invLineMap.get(a.invoice_id) || [];
    const totalLineAmt = lines.reduce((s, l) => s + Number(l.amount), 0) || Number(a.amount);
    const ratio = Number(a.amount) / totalLineAmt;
    if (!lines.length) {
      revByAcct.set('unspecified', (revByAcct.get('unspecified') || 0) + Number(a.amount));
    } else {
      for (const l of lines) {
        const key = l.revenue_account_id || 'unspecified';
        revByAcct.set(key, (revByAcct.get(key) || 0) + Number(l.amount) * ratio);
      }
    }
  }
  // Expenses by account
  const expByAcct = new Map();
  const cogsByAcct = new Map();
  for (const a of outApps) {
    const lines = billLineMap.get(a.bill_id) || [];
    const totalLineAmt = lines.reduce((s, l) => s + Number(l.amount), 0) || Number(a.amount);
    const ratio = Number(a.amount) / totalLineAmt;
    if (!lines.length) {
      expByAcct.set('unspecified', (expByAcct.get('unspecified') || 0) + Number(a.amount));
    } else {
      for (const l of lines) {
        const acct = acctMap.get(l.expense_account_id);
        const bucket = acct?.type === 'cogs' ? cogsByAcct : expByAcct;
        const key = l.expense_account_id || 'unspecified';
        bucket.set(key, (bucket.get(key) || 0) + Number(l.amount) * ratio);
      }
    }
  }
  const totalRev = [...revByAcct.values()].reduce((s, v) => s + v, 0);
  const totalCogs = [...cogsByAcct.values()].reduce((s, v) => s + v, 0);
  const totalExp = [...expByAcct.values()].reduce((s, v) => s + v, 0);
  const grossMargin = totalRev - totalCogs;
  const netIncome = grossMargin - totalExp;
  const fmtAcct = (id) => {
    if (id === 'unspecified') return 'Unspecified';
    const a = acctMap.get(id);
    return a ? `${a.account_number} — ${a.name}` : 'Unknown';
  };
  const sect = (title, map) => {
    const rows = [...map.entries()].sort((a, b) => b[1] - a[1]);
    if (!rows.length) return `<tr><td colspan="2" class="muted">No ${title.toLowerCase()}</td></tr>`;
    return `
      <tr><td colspan="2" class="section-title" style="padding-top:14px">${title}</td></tr>
      ${rows.map(([id, v]) => `<tr><td style="padding-left:20px">${escapeHtml(fmtAcct(id))}</td><td class="numeric">${fmtMoney(v)}</td></tr>`).join('')}
    `;
  };
  out.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="section-title">PROFIT &amp; LOSS · ${fmtDate(from)} – ${fmtDate(to)}</div>
        <div class="muted">Cash basis</div>
      </div>
      <table class="data">
        ${sect('REVENUE', revByAcct)}
        <tr><td><strong>Total Revenue</strong></td><td class="numeric"><strong>${fmtMoney(totalRev)}</strong></td></tr>
        ${sect('COST OF GOODS SOLD', cogsByAcct)}
        <tr><td><strong>Total COGS</strong></td><td class="numeric"><strong>${fmtMoney(totalCogs)}</strong></td></tr>
        <tr><td style="border-top:2px solid var(--ink-300)"><strong>Gross Profit</strong></td><td class="numeric ${grossMargin >= 0 ? 'delta-up' : 'delta-down'}" style="border-top:2px solid var(--ink-300)"><strong>${fmtMoney(grossMargin)}</strong></td></tr>
        ${sect('OPERATING EXPENSES', expByAcct)}
        <tr><td><strong>Total Operating Expenses</strong></td><td class="numeric"><strong>${fmtMoney(totalExp)}</strong></td></tr>
        <tr><td style="border-top:2px solid var(--ink-300)"><strong>Net Income</strong></td><td class="numeric ${netIncome >= 0 ? 'delta-up' : 'delta-down'}" style="border-top:2px solid var(--ink-300)"><strong>${fmtMoney(netIncome)}</strong></td></tr>
      </table>
    </div>
  `;
  window.__lastRep = { kind: 'pnl', rows: [['Section','Account','Amount'],...buildPnlCSV(revByAcct, cogsByAcct, expByAcct, fmtAcct)] };
}

function buildPnlCSV(rev, cogs, exp, fmtAcct) {
  const rows = [];
  rev.forEach((v, k) => rows.push(['Revenue', fmtAcct(k), v.toFixed(2)]));
  cogs.forEach((v, k) => rows.push(['COGS', fmtAcct(k), v.toFixed(2)]));
  exp.forEach((v, k) => rows.push(['Expense', fmtAcct(k), v.toFixed(2)]));
  return rows;
}

async function runAR(out) {
  const [invoices, customers] = await Promise.all([
    q(supabase.from('invoices').select('*').neq('status', 'void').neq('status', 'paid').neq('status', 'draft')),
    q(supabase.from('customers').select('id, name')),
  ]);
  const custMap = new Map(customers.map(c => [c.id, c]));
  const rows = invoices.map(i => {
    const open = Number(i.total) - Number(i.amount_paid);
    return { ...i, _open: open, _days: daysPastDue(i.due_date), _customer: custMap.get(i.customer_id) };
  }).filter(r => r._open > 0).sort((a, b) => b._days - a._days);
  out.innerHTML = `
    <div class="card">
      <div class="card-header"><div class="section-title">AR AGING DETAIL</div></div>
      <table class="data">
        <thead><tr><th>Invoice #</th><th>Customer</th><th>Due</th><th class="numeric">Open</th><th>Days Late</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr>
            <td class="mono">${escapeHtml(r.invoice_number || '')}</td>
            <td>${escapeHtml(r._customer?.name || '—')}</td>
            <td>${fmtDate(r.due_date)}</td>
            <td class="numeric">${fmtMoney(r._open)}</td>
            <td>${r._days > 0 ? `<span style="color:var(--red)">${r._days}</span>` : '<span class="muted">current</span>'}</td>
          </tr>`).join('')}
          <tr><td colspan="3"><strong>Total</strong></td><td class="numeric"><strong>${fmtMoney(rows.reduce((s,r)=>s+r._open,0))}</strong></td><td></td></tr>
        </tbody>
      </table>
    </div>
  `;
  window.__lastRep = { kind: 'ar', rows: [['Invoice','Customer','Due','Open','Days Late'], ...rows.map(r => [r.invoice_number, r._customer?.name || '', r.due_date, r._open.toFixed(2), r._days])] };
}

async function runAP(out) {
  const [bills, vendors] = await Promise.all([
    q(supabase.from('bills').select('*').neq('status', 'void').neq('status', 'paid')),
    q(supabase.from('vendors').select('id, name')),
  ]);
  const venMap = new Map(vendors.map(v => [v.id, v]));
  const rows = bills.map(b => {
    const open = Number(b.total) - Number(b.amount_paid);
    return { ...b, _open: open, _days: daysPastDue(b.due_date), _vendor: venMap.get(b.vendor_id) };
  }).filter(r => r._open > 0).sort((a, b) => b._days - a._days);
  out.innerHTML = `
    <div class="card">
      <div class="card-header"><div class="section-title">AP AGING DETAIL</div></div>
      <table class="data">
        <thead><tr><th>Bill #</th><th>Vendor</th><th>Due</th><th class="numeric">Open</th><th>Days Late</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr>
            <td class="mono">${escapeHtml(r.bill_number || '')}</td>
            <td>${escapeHtml(r._vendor?.name || '—')}</td>
            <td>${fmtDate(r.due_date)}</td>
            <td class="numeric">${fmtMoney(r._open)}</td>
            <td>${r._days > 0 ? `<span style="color:var(--red)">${r._days}</span>` : '<span class="muted">current</span>'}</td>
          </tr>`).join('')}
          <tr><td colspan="3"><strong>Total</strong></td><td class="numeric"><strong>${fmtMoney(rows.reduce((s,r)=>s+r._open,0))}</strong></td><td></td></tr>
        </tbody>
      </table>
    </div>
  `;
  window.__lastRep = { kind: 'ap', rows: [['Bill','Vendor','Due','Open','Days Late'], ...rows.map(r => [r.bill_number, r._vendor?.name || '', r.due_date, r._open.toFixed(2), r._days])] };
}

async function runProjectPnL(out) {
  const [projects, invoices, bills] = await Promise.all([
    q(supabase.from('projects').select('*')),
    q(supabase.from('invoices').select('project_id, total, amount_paid, status')),
    q(supabase.from('bills').select('project_id, total, amount_paid, status')),
  ]);
  const data = projects.map(p => {
    const invoiced = invoices.filter(i => i.project_id === p.id && i.status !== 'void').reduce((s, i) => s + Number(i.total), 0);
    const collected = invoices.filter(i => i.project_id === p.id && i.status !== 'void').reduce((s, i) => s + Number(i.amount_paid), 0);
    const cost = bills.filter(b => b.project_id === p.id && b.status !== 'void').reduce((s, b) => s + Number(b.total), 0);
    const margin = invoiced - cost;
    const pct = invoiced > 0 ? (margin / invoiced * 100) : 0;
    return { ...p, _invoiced: invoiced, _collected: collected, _cost: cost, _margin: margin, _pct: pct };
  }).sort((a, b) => b._invoiced - a._invoiced);
  out.innerHTML = `
    <div class="card">
      <div class="card-header"><div class="section-title">PROJECT P&amp;L</div></div>
      <table class="data">
        <thead><tr><th>#</th><th>Project</th><th>Status</th><th class="numeric">Contract</th><th class="numeric">Invoiced</th><th class="numeric">Collected</th><th class="numeric">Cost</th><th class="numeric">Margin</th><th>%</th></tr></thead>
        <tbody>
          ${data.map(p => `<tr>
            <td class="mono">${escapeHtml(p.project_number || '')}</td>
            <td>${escapeHtml(p.name)}</td>
            <td><span class="pill pill-gray">${(p.status || '').toUpperCase()}</span></td>
            <td class="numeric">${fmtMoney(p.contract_amount || 0)}</td>
            <td class="numeric">${fmtMoney(p._invoiced)}</td>
            <td class="numeric">${fmtMoney(p._collected)}</td>
            <td class="numeric">${fmtMoney(p._cost)}</td>
            <td class="numeric ${p._margin >= 0 ? 'delta-up' : 'delta-down'}">${fmtMoney(p._margin)}</td>
            <td class="numeric">${p._pct.toFixed(1)}%</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
  window.__lastRep = { kind: 'proj', rows: [['#','Project','Status','Contract','Invoiced','Collected','Cost','Margin','%'], ...data.map(p => [p.project_number, p.name, p.status, p.contract_amount, p._invoiced, p._collected, p._cost, p._margin, p._pct.toFixed(1)])] };
}

async function runCash(from, to, out) {
  const [payments, banks] = await Promise.all([
    q(supabase.from('payments').select('*').gte('date', from).lte('date', to).order('date')),
    q(supabase.from('bank_accounts').select('id, name')),
  ]);
  const bankMap = new Map(banks.map(b => [b.id, b]));
  const totalIn = payments.filter(p => p.direction === 'received').reduce((s, p) => s + Number(p.amount), 0);
  const totalOut = payments.filter(p => p.direction === 'sent').reduce((s, p) => s + Number(p.amount), 0);
  const net = totalIn - totalOut;
  out.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="section-title">CASH ACTIVITY · ${fmtDate(from)} – ${fmtDate(to)}</div>
        <div class="muted">In ${fmtMoney(totalIn)} · Out ${fmtMoney(totalOut)} · Net <span class="${net >= 0 ? 'delta-up' : 'delta-down'}">${fmtMoney(net)}</span></div>
      </div>
      <table class="data">
        <thead><tr><th>Date</th><th>Direction</th><th>Method</th><th>Reference</th><th>Bank</th><th class="numeric">Amount</th></tr></thead>
        <tbody>
          ${payments.map(p => `<tr>
            <td>${fmtDate(p.date)}</td>
            <td>${p.direction === 'received' ? '<span class="pill pill-green">IN</span>' : '<span class="pill pill-amber">OUT</span>'}</td>
            <td>${escapeHtml((p.method || '').toUpperCase())}</td>
            <td class="mono">${escapeHtml(p.reference || '')}</td>
            <td>${escapeHtml(bankMap.get(p.bank_account_id)?.name || '—')}</td>
            <td class="numeric">${fmtMoney(p.amount)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
  window.__lastRep = { kind: 'cash', rows: [['Date','Direction','Method','Reference','Bank','Amount'], ...payments.map(p => [p.date, p.direction, p.method, p.reference || '', bankMap.get(p.bank_account_id)?.name || '', Number(p.amount).toFixed(2)])] };
}

function exportCSV() {
  const rep = window.__lastRep;
  if (!rep) { toast('Run a report first', { kind: 'error' }); return; }
  const csv = rep.rows.map(r => r.map(c => {
    const s = String(c ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `report-${rep.kind}-${fmtDateISO(new Date())}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Exported', { kind: 'success' });
}
