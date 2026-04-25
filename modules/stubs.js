// =============================================================================
// Stubs for modules that will be built in later iterations. Each exports a
// render function that shows a "coming soon" panel with a short note about
// what will go here. This keeps the sidebar fully navigable from day one.
// =============================================================================

function makeStub(title, subtitle, note) {
  return (outlet) => {
    outlet.innerHTML = `
      <div class="page-head">
        <div class="page-head-left">
          <h1>${title.toUpperCase()}</h1>
          <div class="page-head-sub">${subtitle}</div>
        </div>
      </div>
      <div class="empty-state">
        <div class="big">COMING SOON</div>
        <div>${note}</div>
      </div>`;
  };
}

export const renderCustomers  = makeStub('Customers',  'GCs and owners',
  'CRUD for customer records. Next build pass.');

export const renderVendors    = makeStub('Vendors',    'Suppliers, subs, utilities',
  'Vendor list with 1099 flagging and W-9 upload. Next build pass.');

export const renderProjects   = makeStub('Projects',   'Jobs for job costing',
  'Project list + project detail with AR/AP drill-down. Next build pass.');

export const renderInvoices   = makeStub('Invoices',   'Accounts Receivable',
  'Invoice list, detail, PDF generator, aging report. Coming after core CRUD.');

export const renderBills      = makeStub('Bills',      'Accounts Payable',
  'Bill entry with receipt upload, payment runs, aging. Coming after invoices.');

export const renderPayments   = makeStub('Payments',   'AR receipts + AP disbursements',
  'Unified payments log with application to invoices and bills.');

export const renderBank       = makeStub('Bank',       'Accounts and transaction feeds',
  'Bank account list, CSV/OFX import for Chase, Capital One, and generic.');

export const renderReconcile  = makeStub('Reconcile',  'Statement reconciliation',
  'Auto-match engine + reconciliation UI with real-time difference calc.');

export const renderReports    = makeStub('Reports',    'P&L, AR/AP aging, job costing',
  'Report library: AR aging, AP aging, job cost by project, P&L.');

export const renderTen99      = makeStub('1099s',      'Year-end 1099-NEC tracking',
  'Per-vendor totals with $600 threshold flag and IRS 1099-NEC CSV export.');

export const renderSettings   = makeStub('Settings',   'Users, COA, chart maintenance',
  'User roles, COA editing, year-end lock, audit log viewer.');
