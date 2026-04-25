// =============================================================================
// Router
// -----------------------------------------------------------------------------
// Hash-based (works on GitHub Pages without URL rewrites).
// Routes are registered as `{ path, handler }` pairs. Handlers receive an
// `outlet` element and render into it.
//
// Usage:
//   register('dashboard', renderDashboard);
//   start();   // reads location.hash and renders
// =============================================================================

const routes = new Map();
let currentPath = null;

export function register(path, handler) {
  routes.set(path, handler);
}

export function start() {
  window.addEventListener('hashchange', handleRouteChange);
  handleRouteChange();
}

export function navigate(path) {
  window.location.hash = '#/' + path;
}

export function getCurrentPath() { return currentPath; }

async function handleRouteChange() {
  const outlet = document.getElementById('route-outlet');
  if (!outlet) return;

  // Parse path from hash. Default = dashboard.
  let hash = window.location.hash || '#/dashboard';
  if (!hash.startsWith('#/')) hash = '#/dashboard';
  const path = hash.slice(2).split('?')[0].split('/')[0] || 'dashboard';

  currentPath = path;
  updateSidebarActive(path);

  const handler = routes.get(path);
  if (!handler) {
    outlet.innerHTML = notFoundHTML(path);
    return;
  }

  // Loading state
  outlet.innerHTML = '<div class="empty-state"><div class="big">LOADING</div><div>Fetching data…</div></div>';

  try {
    await handler(outlet);
  } catch (e) {
    console.error('[router] handler error for', path, e);
    outlet.innerHTML = errorHTML(e);
  }
}

function updateSidebarActive(path) {
  document.querySelectorAll('#sidebar-nav a').forEach(a => {
    a.classList.toggle('active', a.dataset.route === path);
  });
}

function notFoundHTML(path) {
  return `
    <div class="empty-state">
      <div class="big">404</div>
      <div>No route: <code>${escapeHtml(path)}</code></div>
    </div>`;
}

function errorHTML(e) {
  return `
    <div class="empty-state">
      <div class="big" style="color: var(--red)">ERROR</div>
      <div>${escapeHtml(e.message || String(e))}</div>
    </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
