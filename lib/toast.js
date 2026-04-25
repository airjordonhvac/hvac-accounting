// =============================================================================
// Toast notifications
// -----------------------------------------------------------------------------
// toast('Saved')
// toast('Something broke', { kind: 'error' })
// toast('Imported 42 rows', { kind: 'success', ms: 4000 })
// =============================================================================

export function toast(message, opts = {}) {
  const { kind = 'info', ms = 3000 } = opts;
  const stack = document.getElementById('toast-stack');
  if (!stack) return;

  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  stack.appendChild(el);

  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  }, ms);
}
