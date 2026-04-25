// =============================================================================
// Formatters
// -----------------------------------------------------------------------------
// Every $ in the app goes through fmtMoney so accountants see consistent
// formatting (trailing zeros, thousands separators, parens for negatives).
// =============================================================================

const moneyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const moneyFmtNoSign = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const dateFmt = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
const dateFmtShort = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** $1,234.56 or ($1,234.56) for negatives. */
export function fmtMoney(n) {
  if (n == null || isNaN(n)) return '—';
  const num = Number(n);
  if (num < 0) return `(${moneyFmt.format(-num)})`;
  return moneyFmt.format(num);
}

/** 1,234.56 — no $ sign, for table columns where the header says "Amount ($)". */
export function fmtNum(n) {
  if (n == null || isNaN(n)) return '—';
  return moneyFmtNoSign.format(Number(n));
}

/** Apr 23, 2026 */
export function fmtDate(d) {
  if (!d) return '—';
  const dt = typeof d === 'string' ? new Date(d + (d.length === 10 ? 'T00:00:00' : '')) : d;
  if (isNaN(dt)) return '—';
  return dateFmt.format(dt);
}

/** Apr 23 — compact for charts */
export function fmtDateShort(d) {
  if (!d) return '—';
  const dt = typeof d === 'string' ? new Date(d + (d.length === 10 ? 'T00:00:00' : '')) : d;
  if (isNaN(dt)) return '—';
  return dateFmtShort.format(dt);
}

/** 2026-04-23 — ISO date for inputs */
export function fmtDateISO(d) {
  const dt = d ? new Date(d) : new Date();
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Days between two dates (positive = d1 is earlier). */
export function daysBetween(d1, d2) {
  const a = new Date(d1 + 'T00:00:00');
  const b = new Date(d2 + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

/** Days overdue (positive = past due). 0 if not yet due. */
export function daysPastDue(due_date, asOf = null) {
  const ref = asOf ? new Date(asOf) : new Date();
  const due = new Date(due_date + 'T00:00:00');
  const diff = Math.floor((ref - due) / 86400000);
  return Math.max(diff, 0);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/** Capitalize + split snake/kebab on spaces. */
export function titleCase(s) {
  if (!s) return '';
  return String(s).replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
