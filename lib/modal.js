// =============================================================================
// Modals (confirm dialog + generic modal)
// -----------------------------------------------------------------------------
// confirm('Void this invoice?', 'This cannot be undone.') → Promise<boolean>
// modal({ title, body, actions }) → Promise
//
// All destructive actions in the app use confirmDialog() per spec.
// =============================================================================

export function confirmDialog(title, message, { okLabel = 'Confirm', cancelLabel = 'Cancel', danger = true } = {}) {
  return new Promise(resolve => {
    const mount = document.getElementById('modal-mount');
    const bg = document.createElement('div');
    bg.className = 'modal-backdrop';
    bg.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head"><h3></h3></div>
        <div class="modal-body"></div>
        <div class="modal-foot">
          <button class="btn-secondary" data-cancel>${escapeHtml(cancelLabel)}</button>
          <button class="${danger ? 'btn-danger' : 'btn-primary'}" data-ok></button>
        </div>
      </div>`;
    bg.querySelector('h3').textContent = title;
    bg.querySelector('.modal-body').textContent = message;
    bg.querySelector('[data-ok]').textContent = okLabel;
    mount.appendChild(bg);

    const cleanup = (val) => { bg.remove(); resolve(val); };
    bg.querySelector('[data-ok]').onclick = () => cleanup(true);
    bg.querySelector('[data-cancel]').onclick = () => cleanup(false);
    bg.addEventListener('click', (e) => { if (e.target === bg) cleanup(false); });
  });
}

/**
 * Generic modal for form content. Pass `bodyHTML` and `actions: [{label, kind, onClick}]`.
 * onClick can return false to keep modal open (e.g. for validation).
 */
export function modal({ title, bodyHTML, actions = [] }) {
  return new Promise(resolve => {
    const mount = document.getElementById('modal-mount');
    const bg = document.createElement('div');
    bg.className = 'modal-backdrop';
    bg.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head"><h3></h3></div>
        <div class="modal-body"></div>
        <div class="modal-foot"></div>
      </div>`;
    bg.querySelector('h3').textContent = title;
    bg.querySelector('.modal-body').innerHTML = bodyHTML;

    const foot = bg.querySelector('.modal-foot');
    actions.forEach((a, idx) => {
      const btn = document.createElement('button');
      btn.className = a.kind === 'danger' ? 'btn-danger'
                   : a.kind === 'secondary' ? 'btn-secondary'
                   : 'btn-primary';
      btn.textContent = a.label;
      btn.onclick = async () => {
        const r = a.onClick ? await a.onClick(bg) : undefined;
        if (r === false) return;  // keep open
        bg.remove();
        resolve({ actionIdx: idx, result: r });
      };
      foot.appendChild(btn);
    });

    mount.appendChild(bg);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
