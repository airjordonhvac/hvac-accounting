// =============================================================================
// Sortable table helper
// -----------------------------------------------------------------------------
// Used across all list-view modules (customers, vendors, projects, invoices,
// bills, payments, bank, etc) so users can click any column header to sort.
//
// Persists per-module sort state on window.__sortState[moduleKey] so navigating
// away and back preserves the user's sort choice in the same session.
//
// USAGE:
//
//   import { sortRows, headerHTML, attachSortHandlers } from '../lib/sort.js';
//
//   const COLUMNS = [
//     { key: 'invoice_number', label: 'Invoice #', type: 'string', mono: true },
//     { key: 'customer_name',  label: 'Customer',  type: 'string',
//       get: r => r._customer?.name || '' },     // when value comes from joined data
//     { key: 'due_date',       label: 'Due',      type: 'date' },
//     { key: 'total',          label: 'Total',    type: 'number', numeric: true },
//     { key: 'open',           label: 'Open',     type: 'number', numeric: true,
//       get: r => Number(r.total) - Number(r.amount_paid) },
//     { key: '_actions',       label: '',         sortable: false },
//   ];
//
//   const state = getSortState('invoices', { key: 'due_date', dir: 'desc' });
//   const sorted = sortRows(rows, COLUMNS, state);
//   const ths = headerHTML(COLUMNS, state);
//
//   wrap.innerHTML = '<table class="data"><thead><tr>' + ths + '</tr></thead>...';
//   attachSortHandlers(wrap, 'invoices', () => /* re-render with new state */);
// =============================================================================

const STATE_KEY = '__sortState';

export function getSortState(moduleKey, fallback) {
  if (!window[STATE_KEY]) window[STATE_KEY] = {};
  if (!window[STATE_KEY][moduleKey]) {
    window[STATE_KEY][moduleKey] = { ...fallback };
  }
  return window[STATE_KEY][moduleKey];
}

export function setSortState(moduleKey, state) {
  if (!window[STATE_KEY]) window[STATE_KEY] = {};
  window[STATE_KEY][moduleKey] = state;
}

// Toggle: if clicking the active column, reverse direction; else activate column with default dir.
export function toggleSort(moduleKey, columnKey, defaultDirForType) {
  const cur = getSortState(moduleKey, { key: null, dir: 'asc' });
  let next;
  if (cur.key === columnKey) {
    next = { key: columnKey, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
  } else {
    next = { key: columnKey, dir: defaultDirForType || 'asc' };
  }
  setSortState(moduleKey, next);
  return next;
}

function getValue(row, col) {
  if (typeof col.get === 'function') return col.get(row);
  return row[col.key];
}

function compareValues(a, b, type) {
  // Nulls always sort to the end regardless of direction
  const aNull = a === null || a === undefined || a === '';
  const bNull = b === null || b === undefined || b === '';
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;

  if (type === 'number') {
    return Number(a) - Number(b);
  }
  if (type === 'date') {
    const ta = new Date(a).getTime();
    const tb = new Date(b).getTime();
    return (isNaN(ta) ? 0 : ta) - (isNaN(tb) ? 0 : tb);
  }
  // string
  return String(a).toLowerCase().localeCompare(String(b).toLowerCase());
}

export function sortRows(rows, columns, state) {
  if (!state || !state.key) return rows.slice();
  const col = columns.find(c => c.key === state.key);
  if (!col) return rows.slice();
  const out = rows.slice();
  out.sort((r1, r2) => {
    const v1 = getValue(r1, col);
    const v2 = getValue(r2, col);
    const cmp = compareValues(v1, v2, col.type || 'string');
    return state.dir === 'desc' ? -cmp : cmp;
  });
  return out;
}

function arrowFor(col, state) {
  if (col.sortable === false) return '';
  const isActive = state && state.key === col.key;
  if (!isActive) return '<span class="sort-arrow">↕</span>';
  return state.dir === 'asc'
    ? '<span class="sort-arrow active">↑</span>'
    : '<span class="sort-arrow active">↓</span>';
}

export function headerHTML(columns, state) {
  return columns.map(col => {
    const sortable = col.sortable !== false;
    const numeric = col.numeric ? ' class="numeric"' : '';
    const cls = sortable ? ' sortable-th' : '';
    const dataKey = sortable ? ` data-sort-key="${col.key}" data-sort-type="${col.type || 'string'}"` : '';
    return `<th${numeric}${dataKey ? ' style="cursor:pointer;user-select:none"' : ''}><span class="${cls.trim()}"${dataKey}>${col.label}${sortable ? ' ' + arrowFor(col, state) : ''}</span></th>`;
  }).join('');
}

// Wires up click handlers on header cells. Call once after rendering.
// onChange runs after toggling so the caller can re-render.
export function attachSortHandlers(wrap, moduleKey, onChange) {
  wrap.querySelectorAll('th [data-sort-key]').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.dataset.sortKey;
      const type = el.dataset.sortType;
      // Numbers and dates default to descending (newest/largest first); strings to ascending
      const defaultDir = (type === 'number' || type === 'date') ? 'desc' : 'asc';
      toggleSort(moduleKey, key, defaultDir);
      onChange();
    });
  });
}
