// =============================================================================
// App bootstrap
// =============================================================================
import { supabase } from './supabase.js';
import * as auth from './auth.js';
import * as router from './router.js';
import { toast } from './toast.js';
import { renderDashboard } from '../modules/dashboard.js';
import { renderInbox } from '../modules/inbox.js';
import { healOrphans } from '../modules/materialize.js';

import { renderCustomers } from '../modules/customers.js?v=sort';
import { renderVendors }   from '../modules/vendors.js?v=sort';
import { renderProjects }  from '../modules/projects.js?v=sort';
import { renderInvoices }  from '../modules/invoices.js?v=sort';
import { renderBills }     from '../modules/bills.js?v=sort';
import { renderPayments }  from '../modules/payments.js?v=sort';
import { renderBank }      from '../modules/bank.js?v=sort';
import { renderReconcile } from '../modules/reconcile.js';
import { renderReports }   from '../modules/reports.js';
import { renderTen99 }     from '../modules/ten99.js?v=sort';
import { renderSettings }  from '../modules/settings.js?v=sort';

router.register('dashboard', renderDashboard);
router.register('inbox',     renderInbox);
router.register('customers', renderCustomers);
router.register('vendors',   renderVendors);
router.register('projects',  renderProjects);
router.register('invoices',  renderInvoices);
router.register('bills',     renderBills);
router.register('payments',  renderPayments);
router.register('bank',      renderBank);
router.register('reconcile', renderReconcile);
router.register('reports',   renderReports);
router.register('ten99',     renderTen99);
router.register('settings',  renderSettings);

const bootSplash  = document.getElementById('boot-splash');
const loginScreen = document.getElementById('login-screen');
const appShell    = document.getElementById('app-shell');

(async function boot() {
  try {
    await new Promise(r => setTimeout(r, 150));
    await new Promise(r => setTimeout(r, 50));
    const profile = await auth.loadCurrentUser();
    if (!profile) showLogin();
    else showApp(profile);
  } catch (e) {
    console.error('[boot] error', e);
    showLogin('Error loading session. Try signing in again.');
  } finally {
    hideBoot();
  }
  auth.onAuthChange(async (event) => {
    if (event === 'SIGNED_OUT') window.location.reload();
    if (event === 'SIGNED_IN') {
      const p = await auth.loadCurrentUser();
      if (p) { hideBoot(); showApp(p); }
    }
  });
})();

function hideBoot() {
  bootSplash?.classList.add('fade');
  setTimeout(() => bootSplash?.classList.add('hidden'), 300);
}

function showLogin(errorMsg = null) {
  loginScreen.classList.remove('hidden');
  appShell.classList.add('hidden');
  wireLogin(errorMsg);
}

function showApp(profile) {
  loginScreen.classList.add('hidden');
  appShell.classList.remove('hidden');
  const initials = (profile.full_name || profile.email || '?')
    .split(/\s+/).slice(0, 2).map(s => s[0]?.toUpperCase() || '').join('') || '?';
  document.getElementById('user-avatar').textContent = initials;
  document.getElementById('user-name').textContent = profile.full_name || profile.email;
  document.getElementById('user-role').textContent = profile.role;
  document.getElementById('logout-btn').onclick = () => auth.signOut();
  if (profile.role === 'crew') {
    const crewAllowed = new Set(['dashboard', 'inbox', 'projects', 'bills', 'vendors', 'customers']);
    document.querySelectorAll('#sidebar-nav a').forEach(a => {
      if (!crewAllowed.has(a.dataset.route)) a.style.display = 'none';
    });
  }
  router.start();
  if (profile.role === 'admin') {
    healOrphans().catch(e => console.warn('[heal] error:', e));
  }
}

function wireLogin(errorMsg) {
  const btn = document.getElementById('login-btn');
  const emailInput = document.getElementById('login-email');
  const status = document.getElementById('login-status');
  if (errorMsg) { status.textContent = errorMsg; status.className = 'login-status error'; }
  else { status.textContent = ''; status.className = 'login-status'; }
  const submit = async () => {
    const email = (emailInput.value || '').trim();
    if (!email) { status.textContent = 'Enter your email.'; status.className = 'login-status error'; return; }
    btn.disabled = true;
    btn.textContent = 'Sending…';
    status.textContent = '';
    status.className = 'login-status';
    try {
      await auth.sendMagicLink(email);
      status.textContent = `Check ${email} for a sign-in link.`;
      status.className = 'login-status success';
      btn.textContent = 'Link sent ✓';
    } catch (e) {
      console.error(e);
      status.textContent = e.message || 'Failed to send link.';
      status.className = 'login-status error';
      btn.disabled = false;
      btn.textContent = 'Send magic link';
    }
  };
  btn.onclick = submit;
  emailInput.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  emailInput.focus();
}
