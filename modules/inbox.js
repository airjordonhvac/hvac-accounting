// =============================================================================
// Inbox — document upload + pending approval queue
// -----------------------------------------------------------------------------
// Four states per doc:
//   uploaded  → file saved, extraction not yet triggered (rare; we auto-trigger)
//   extracting → edge function running Claude API
//   pending    → extraction done, awaiting admin approval
//   approved/rejected → terminal
//
// UI:
//   - Upload zone (drag, click, paste) with doc-type selector
//   - Queue tabs: Pending (N) / Processing / Resolved
//   - Side-by-side review: PDF preview ⟷ editable form, Approve/Reject buttons
// =============================================================================

import { supabase } from '../lib/supabase.js';
import { fmtMoney, fmtDate, escapeHtml } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { confirmDialog } from '../lib/modal.js';
import { isAdmin, getCurrentUser } from '../lib/auth.js';
import { materialize } from './materialize.js';

const STORAGE_BUCKET = 'extraction-queue';

export async function renderInbox(outlet) {
  outlet.innerHTML = `
    <div class="page-head">
      <div class="page-head-left">
        <h1>INBOX</h1>
        <div class="page-head-sub">Drop vendor bills, contracts, bank statements, or W-9s to auto-file</div>
      </div>
    </div>

    <!-- Upload zone -->
    <div class="upload-zone" id="upload-zone">
      <div class="upload-zone-inner">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <div class="upload-head">Drop files here or click to browse</div>
        <div class="upload-sub">PDF, JPG, PNG · up to 10MB per file · paste from clipboard also works</div>

        <div class="upload-type-row">
          <label class="field-label" style="margin-bottom: 4px">Document type</label>
          <select id="upload-type">
            <option value="bill">Vendor Bill / Receipt</option>
            <option value="contract">Customer PO / Contract</option>
            <option value="bank_statement">Bank / Credit Card Statement</option>
            <option value="w9">W-9 Form</option>
          </select>
        </div>

        <input type="file" id="upload-input" multiple accept="application/pdf,image/jpeg,image/png" style="display:none">
      </div>
    </div>

    <!-- Queue tabs -->
    <div class="inbox-tabs" id="inbox-tabs">
      <button class="inbox-tab active" data-tab="pending">Pending <span class="tab-count" id="count-pending">—</span></button>
      <button class="inbox-tab" data-tab="extracting">Processing <span class="tab-count" id="count-extracting">—</span></button>
      <button class="inbox-tab" data-tab="resolved">Resolved</button>
    </div>

    <div id="inbox-list"></div>
  `;

  injectInboxStyles();
  wireUploadZone();
  wireTabs();
  await loadQueue('pending');
}

// -----------------------------------------------------------------------------
// Upload handling
// -----------------------------------------------------------------------------
function wireUploadZone() {
  const zone = document.getElementById('upload-zone');
  const input = document.getElementById('upload-input');
  const typeSelect = document.getElementById('upload-type');

  const trigger = () => input.click();
  zone.onclick = (e) => {
    // Don't re-open file picker when user clicks the type selector
    if (e.target.closest('.upload-type-row')) return;
    trigger();
  };

  input.onchange = async () => {
    const files = Array.from(input.files || []);
    for (const file of files) {
      await uploadFile(file, typeSelect.value);
    }
    input.value = '';
    await loadQueue('pending');
  };

  // Drag and drop
  ['dragenter', 'dragover'].forEach(ev =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('dragover'); }));
  zone.addEventListener('drop', async (e) => {
    const files = Array.from(e.dataTransfer.files || []);
    for (const file of files) await uploadFile(file, typeSelect.value);
    await loadQueue('pending');
  });

  // Paste from clipboard
  document.addEventListener('paste', async (e) => {
    // Only handle paste when inbox page is active
    if (!document.getElementById('upload-zone')) return;
    const items = Array.from(e.clipboardData?.items || []);
    const files = items.filter(i => i.kind === 'file').map(i => i.getAsFile());
    if (!files.length) return;
    for (const file of files) await uploadFile(file, typeSelect.value);
    await loadQueue('pending');
  });
}

async function uploadFile(file, docType) {
  const user = getCurrentUser();
  if (!user) { toast('Not signed in', { kind: 'error' }); return; }

  // Validate
  const maxBytes = 10 * 1024 * 1024;
  if (file.size > maxBytes) {
    toast(`${file.name} too large (${(file.size / 1024 / 1024).toFixed(1)}MB, max 10MB)`, { kind: 'error' });
    return;
  }

  toast(`Uploading ${file.name}...`);

  // 1. Upload to Supabase Storage
  const storageKey = `${user.id}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const { error: upErr } = await supabase.storage.from(STORAGE_BUCKET).upload(storageKey, file, {
    contentType: file.type,
    upsert: false,
  });
  if (upErr) {
    toast(`Upload failed: ${upErr.message}`, { kind: 'error' });
    return;
  }

  // 2. Create documents row
  const { data: docRow, error: docErr } = await supabase.from('documents').insert({
    doc_type: docType,
    storage_path: `${STORAGE_BUCKET}/${storageKey}`,
    original_filename: file.name,
    mime_type: file.type,
    file_size_bytes: file.size,
    status: 'uploaded',
    uploaded_by: user.id,
  }).select().single();
  if (docErr) {
    toast(`DB insert failed: ${docErr.message}`, { kind: 'error' });
    return;
  }

  // 3. Kick off extraction via edge function (async — don't await the result
  //    completion, just the invoke. The UI will poll or the user reloads.)
  supabase.functions.invoke('extract', { body: { document_id: docRow.id } })
    .then(({ error }) => {
      if (error) toast(`Extraction failed for ${file.name}: ${error.message}`, { kind: 'error' });
    });

  toast(`${file.name} uploaded — extracting...`, { kind: 'success' });
}

// -----------------------------------------------------------------------------
// Queue tabs
// -----------------------------------------------------------------------------
function wireTabs() {
  document.querySelectorAll('#inbox-tabs .inbox-tab').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('#inbox-tabs .inbox-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadQueue(btn.dataset.tab);
    };
  });
}

async function loadQueue(tab) {
  const list = document.getElementById('inbox-list');
  if (!list) return;
  list.innerHTML = '<div class="empty-state"><div class="big">LOADING</div></div>';

  let statusFilter;
  if (tab === 'pending') statusFilter = ['pending'];
  else if (tab === 'extracting') statusFilter = ['uploaded', 'extracting', 'failed'];
  else statusFilter = ['approved', 'rejected'];

  const { data: docs, error } = await supabase
    .from('documents')
    .select('id, doc_type, original_filename, status, uploaded_at, processed_at, extraction_error, storage_path')
    .in('status', statusFilter)
    .order('uploaded_at', { ascending: false })
    .limit(50);

  if (error) {
    list.innerHTML = `<div class="empty-state"><div class="big">ERROR</div><div>${error.message}</div></div>`;
    return;
  }

  // Update tab counts
  await refreshTabCounts();

  if (!docs?.length) {
    list.innerHTML = `<div class="empty-state"><div class="big">EMPTY</div><div>No documents in this tab.</div></div>`;
    return;
  }

  if (tab === 'pending') {
    // Pending: show side-by-side review cards
    const cardsHtml = await Promise.all(docs.map(d => renderPendingCard(d)));
    list.innerHTML = cardsHtml.join('');
    wirePendingActions();
  } else {
    // Processing / Resolved: show compact list
    list.innerHTML = renderCompactList(docs);
  }
}

async function refreshTabCounts() {
  const { count: pendingCount } = await supabase.from('documents')
    .select('id', { count: 'exact', head: true }).eq('status', 'pending');
  const { count: processingCount } = await supabase.from('documents')
    .select('id', { count: 'exact', head: true }).in('status', ['uploaded', 'extracting']);
  document.getElementById('count-pending').textContent = pendingCount ?? '—';
  document.getElementById('count-extracting').textContent = processingCount ?? '—';
}

// -----------------------------------------------------------------------------
// Pending review card — the heart of the UX
// -----------------------------------------------------------------------------
async function renderPendingCard(doc) {
  // Fetch the pending entry
  const { data: entries } = await supabase.from('pending_entries')
    .select('*').eq('document_id', doc.id).eq('status', 'pending').limit(1);
  const entry = entries?.[0];
  if (!entry) return '';  // race condition / mismatch

  // Get signed URL for preview
  const [bucket, ...keyParts] = doc.storage_path.split('/');
  const { data: signed } = await supabase.storage.from(bucket)
    .createSignedUrl(keyParts.join('/'), 300);  // 5 min
  const previewUrl = signed?.signedUrl || '';

  const confidence = Number(entry.confidence ?? 0);
  const confClass = confidence >= 0.85 ? 'high' : confidence >= 0.65 ? 'med' : 'low';

  return `
    <div class="review-card" data-doc-id="${doc.id}" data-entry-id="${entry.id}">
      <div class="review-head">
        <div>
          <strong>${escapeHtml(doc.original_filename)}</strong>
          <span class="pill pill-${doc.doc_type === 'bill' ? 'open' : 'active'}">${doc.doc_type.replace('_',' ')}</span>
          <span class="confidence confidence-${confClass}">${(confidence * 100).toFixed(0)}% confidence</span>
        </div>
        <div class="review-meta">Uploaded ${fmtDate(doc.uploaded_at)}</div>
      </div>
      <div class="review-body">
        <div class="review-preview">
          ${previewUrl
            ? (doc.mime_type?.startsWith('image/')
                ? `<img src="${previewUrl}" alt="Document preview">`
                : `<iframe src="${previewUrl}" title="Document preview"></iframe>`)
            : '<div class="muted">Preview unavailable</div>'}
        </div>
        <div class="review-form">
          ${renderReviewForm(doc.doc_type, entry)}
          <div class="review-actions">
            <button class="btn-danger" data-action="reject">Reject</button>
            <button class="btn-secondary" data-action="edit">Edit</button>
            <button class="btn-primary" data-action="approve">Approve &amp; Save</button>
          </div>
          ${entry.match_notes ? `<div class="match-notes">${escapeHtml(entry.match_notes)}</div>` : ''}
        </div>
      </div>
    </div>`;
}

function renderReviewForm(docType, entry) {
  const raw = entry.raw_extraction || {};
  if (docType === 'bill') {
    const lines = (raw.lines || []).map(l =>
      `<div class="line-row">
        <span class="line-desc">${escapeHtml(l.description || '')}</span>
        <span class="mono">${Number(l.quantity || 1)} × ${fmtMoney(l.rate || 0)}</span>
        <span class="mono num">${fmtMoney(l.amount || 0)}</span>
      </div>`).join('');
    return `
      <div class="kv-grid">
        <div class="kv"><span>Vendor</span><strong>${escapeHtml(raw.vendor_name || '—')}</strong></div>
        <div class="kv"><span>Bill #</span><strong>${escapeHtml(raw.bill_number || '—')}</strong></div>
        <div class="kv"><span>Date</span><strong>${escapeHtml(raw.bill_date || '—')}</strong></div>
        <div class="kv"><span>Due</span><strong>${escapeHtml(raw.due_date || '—')}</strong></div>
        <div class="kv"><span>Project hint</span><strong>${escapeHtml(raw.project_hint || '—')}</strong></div>
      </div>
      ${lines ? `<div class="line-items">${lines}</div>` : ''}
      <div class="total-row">
        <span>Subtotal <strong class="mono">${fmtMoney(raw.subtotal || 0)}</strong></span>
        <span>Tax <strong class="mono">${fmtMoney(raw.tax || 0)}</strong></span>
        <span class="total-big">Total <strong class="mono">${fmtMoney(raw.total || 0)}</strong></span>
      </div>
    `;
  }
  if (docType === 'contract') {
    return `
      <div class="kv-grid">
        <div class="kv"><span>Customer</span><strong>${escapeHtml(raw.customer_name || '—')}</strong></div>
        <div class="kv"><span>Project</span><strong>${escapeHtml(raw.project_name || '—')}</strong></div>
        <div class="kv"><span>Address</span><strong>${escapeHtml(raw.project_address || '—')}</strong></div>
        <div class="kv"><span>Contract amount</span><strong class="mono">${fmtMoney(raw.contract_amount || 0)}</strong></div>
        <div class="kv"><span>Retainage</span><strong>${raw.retainage_percent ? raw.retainage_percent + '%' : '—'}</strong></div>
        <div class="kv"><span>Terms</span><strong>${escapeHtml(raw.payment_terms || '—')}</strong></div>
      </div>
      ${raw.scope_summary ? `<div class="scope">${escapeHtml(raw.scope_summary)}</div>` : ''}
    `;
  }
  if (docType === 'bank_statement') {
    const txns = (raw.transactions || []).slice(0, 10);
    const txnRows = txns.map(t =>
      `<div class="line-row">
        <span class="mono muted">${escapeHtml(t.date || '')}</span>
        <span class="line-desc">${escapeHtml(t.description || '')}</span>
        <span class="mono num ${Number(t.amount) < 0 ? 'delta-down' : 'delta-up'}">${fmtMoney(t.amount || 0)}</span>
      </div>`).join('');
    return `
      <div class="kv-grid">
        <div class="kv"><span>Account</span><strong>···${escapeHtml(raw.account_last4 || '—')}</strong></div>
        <div class="kv"><span>Period</span><strong>${escapeHtml(raw.statement_period_start || '—')} → ${escapeHtml(raw.statement_period_end || '—')}</strong></div>
        <div class="kv"><span>Opening</span><strong class="mono">${fmtMoney(raw.opening_balance || 0)}</strong></div>
        <div class="kv"><span>Closing</span><strong class="mono">${fmtMoney(raw.closing_balance || 0)}</strong></div>
        <div class="kv"><span>Transactions</span><strong>${(raw.transactions || []).length}</strong></div>
      </div>
      <div class="line-items">${txnRows}${(raw.transactions || []).length > 10 ? `<div class="muted" style="padding:6px 0">+${raw.transactions.length - 10} more…</div>` : ''}</div>
    `;
  }
  if (docType === 'w9') {
    return `
      <div class="kv-grid">
        <div class="kv"><span>Legal name</span><strong>${escapeHtml(raw.legal_name || '—')}</strong></div>
        <div class="kv"><span>DBA</span><strong>${escapeHtml(raw.business_name || '—')}</strong></div>
        <div class="kv"><span>Classification</span><strong>${escapeHtml(raw.tax_classification || '—')}</strong></div>
        <div class="kv"><span>Tax ID</span><strong class="mono">${escapeHtml(raw.tax_id || '—')}</strong></div>
        <div class="kv"><span>Address</span><strong>${escapeHtml((raw.address || '') + ', ' + (raw.city || '') + ' ' + (raw.state || '') + ' ' + (raw.zip || ''))}</strong></div>
        <div class="kv"><span>Signed</span><strong>${raw.signed ? '✓ ' + (raw.signed_date || '') : '✗ Not signed'}</strong></div>
      </div>
    `;
  }
  return `<pre class="raw-json">${escapeHtml(JSON.stringify(raw, null, 2))}</pre>`;
}

function wirePendingActions() {
  document.querySelectorAll('.review-card').forEach(card => {
    const docId = card.dataset.docId;
    const entryId = card.dataset.entryId;
    card.querySelector('[data-action="approve"]').onclick = () => approveEntry(docId, entryId);
    card.querySelector('[data-action="reject"]').onclick = () => rejectEntry(docId, entryId);
    card.querySelector('[data-action="edit"]').onclick = () => {
      toast('Edit mode coming next build — for now approve/reject only', { kind: 'info' });
    };
  });
}

async function approveEntry(docId, entryId) {
  if (!isAdmin()) {
    toast('Only admins can approve entries', { kind: 'error' });
    return;
  }

  // Fetch full entry + document so materialize() has what it needs.
  const { data: entry, error: e1 } = await supabase.from('pending_entries')
    .select('*').eq('id', entryId).single();
  if (e1) { toast('Could not load entry: ' + e1.message, { kind: 'error' }); return; }
  const { data: doc, error: e2 } = await supabase.from('documents')
    .select('*').eq('id', docId).single();
  if (e2) { toast('Could not load document: ' + e2.message, { kind: 'error' }); return; }

  // Build confirmation message that surfaces what's about to be created — this
  // is where we tell the user "creates new vendor: X" if the matched_vendor_id
  // is null.
  const willCreateNew = buildCreationPreview(entry);
  const ok = await confirmDialog(
    'Approve and save?',
    willCreateNew
      ? `Create record from this document. ${willCreateNew}`
      : 'Create record from this document and mark approved.',
    { okLabel: 'Approve', danger: false }
  );
  if (!ok) return;

  // Materialize. This creates the real record and flips pending status.
  const result = await materialize(entry, doc);
  if (!result.ok) {
    toast('Approval failed: ' + result.error, { kind: 'error', ms: 6000 });
    return;
  }

  const labelMap = {
    bills: 'Bill created',
    projects: 'Project created',
    import_batches: 'Statement imported',
    vendors: 'Vendor updated',
  };
  toast(labelMap[result.table] || 'Record created', { kind: 'success' });

  if (result.note) toast(result.note, { kind: 'info', ms: 4500 });

  await loadQueue('pending');
}

/** Tells the user what *new* records (if any) approval will create. */
function buildCreationPreview(entry) {
  const raw = entry.raw_extraction || {};
  const parts = [];
  if (entry.entry_type === 'bill') {
    if (!entry.matched_vendor_id && raw.vendor_name) {
      parts.push(`Will create new vendor: ${raw.vendor_name}.`);
    }
    if (raw.lines?.length) {
      parts.push(`${raw.lines.length} line item${raw.lines.length === 1 ? '' : 's'}.`);
    }
  } else if (entry.entry_type === 'project') {
    if (!entry.matched_customer_id && raw.customer_name) {
      parts.push(`Will create new customer: ${raw.customer_name}.`);
    }
  } else if (entry.entry_type === 'bank_transactions') {
    parts.push(`${raw.transactions?.length || 0} transactions to import.`);
  } else if (entry.entry_type === 'vendor_update') {
    if (!entry.matched_vendor_id) {
      parts.push(`Will create new vendor from W-9: ${raw.legal_name || raw.business_name}.`);
    } else {
      parts.push('Will update existing vendor with W-9 details and mark as 1099.');
    }
  }
  return parts.join(' ');
}

async function rejectEntry(docId, entryId) {
  const reason = prompt('Rejection reason? (optional)');
  if (reason === null) return;  // user cancelled
  const { error } = await supabase.from('pending_entries').update({
    status: 'rejected',
    rejected_reason: reason || null,
    rejected_at: new Date().toISOString(),
  }).eq('id', entryId);
  if (error) { toast(error.message, { kind: 'error' }); return; }
  toast('Rejected', { kind: 'success' });
  await loadQueue('pending');
}

// -----------------------------------------------------------------------------
// Compact list for processing / resolved tabs
// -----------------------------------------------------------------------------
function renderCompactList(docs) {
  const rows = docs.map(d => {
    const statusPill = {
      uploaded: '<span class="pill pill-draft">Uploaded</span>',
      extracting: '<span class="pill pill-bidding">Extracting</span>',
      pending: '<span class="pill pill-sent">Pending</span>',
      approved: '<span class="pill pill-paid">Approved</span>',
      rejected: '<span class="pill pill-void">Rejected</span>',
      failed: '<span class="pill pill-overdue">Failed</span>',
    }[d.status] || d.status;
    const err = d.extraction_error
      ? `<div class="muted" style="font-size:11px;margin-top:4px">${escapeHtml(d.extraction_error.slice(0, 150))}</div>`
      : '';
    return `<tr>
      <td>${escapeHtml(d.original_filename)}</td>
      <td class="muted">${d.doc_type.replace('_',' ')}</td>
      <td>${statusPill}${err}</td>
      <td class="muted">${fmtDate(d.uploaded_at)}</td>
    </tr>`;
  }).join('');
  return `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>File</th><th>Type</th><th>Status</th><th>Uploaded</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

// -----------------------------------------------------------------------------
// Styles specific to Inbox (injected once, scoped by class names)
// -----------------------------------------------------------------------------
function injectInboxStyles() {
  if (document.getElementById('inbox-style')) return;
  const style = document.createElement('style');
  style.id = 'inbox-style';
  style.textContent = `
    .upload-zone {
      background: var(--white);
      border: 2px dashed var(--ink-300);
      border-radius: var(--card-radius);
      padding: 32px;
      text-align: center;
      cursor: pointer;
      transition: all 0.15s;
      margin-bottom: 20px;
    }
    .upload-zone:hover { border-color: var(--sky); background: var(--ink-50); }
    .upload-zone.dragover { border-color: var(--gold); background: rgba(212,175,55,0.08); }
    .upload-zone svg { color: var(--ink-400); margin-bottom: 12px; }
    .upload-head { font-family: var(--font-display); font-size: 22px; letter-spacing: 1.2px; color: var(--navy); }
    .upload-sub { font-size: 12px; color: var(--ink-500); margin-top: 6px; }
    .upload-type-row { max-width: 280px; margin: 18px auto 0; text-align: left; }
    .upload-type-row select { width: 100%; padding: 8px 10px; border: var(--hairline); border-radius: var(--ctrl-radius); font-size: 13px; background: var(--white); }

    .inbox-tabs { display: flex; gap: 2px; border-bottom: var(--hairline); margin-bottom: 16px; }
    .inbox-tab {
      background: transparent; border: none; padding: 10px 16px;
      font-family: var(--font-body); font-size: 13px; font-weight: 600;
      color: var(--ink-500); cursor: pointer; border-bottom: 2px solid transparent;
      transition: all 0.12s; display: inline-flex; align-items: center; gap: 8px;
    }
    .inbox-tab:hover { color: var(--navy); }
    .inbox-tab.active { color: var(--navy); border-bottom-color: var(--gold); }
    .tab-count {
      background: var(--ink-100); color: var(--ink-500);
      padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 700;
    }
    .inbox-tab.active .tab-count { background: var(--gold); color: var(--navy); }

    .review-card {
      background: var(--white); border: var(--hairline); border-radius: var(--card-radius);
      box-shadow: var(--shadow-sm); margin-bottom: 16px; overflow: hidden;
    }
    .review-head {
      display: flex; justify-content: space-between; align-items: center;
      padding: 14px 18px; border-bottom: var(--hairline); background: var(--ink-50);
      gap: 12px; flex-wrap: wrap;
    }
    .review-meta { font-size: 11px; color: var(--ink-500); }
    .confidence {
      display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px;
      border-radius: 10px; margin-left: 8px; letter-spacing: 0.3px;
    }
    .confidence-high { background: var(--green-soft); color: var(--green); }
    .confidence-med  { background: var(--amber-soft); color: var(--amber); }
    .confidence-low  { background: var(--red-soft);   color: var(--red); }

    .review-body { display: grid; grid-template-columns: 1fr 1fr; min-height: 520px; }
    .review-preview { background: var(--ink-100); overflow: hidden; }
    .review-preview img, .review-preview iframe {
      width: 100%; height: 100%; min-height: 520px; border: none; display: block; object-fit: contain;
    }
    .review-form { padding: 18px; display: flex; flex-direction: column; gap: 14px; }

    .kv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 18px; }
    .kv { display: flex; flex-direction: column; font-size: 13px; }
    .kv span { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: var(--ink-500); font-weight: 600; }
    .kv strong { color: var(--navy); margin-top: 2px; }

    .line-items {
      border-top: var(--hairline); padding-top: 10px;
      max-height: 180px; overflow-y: auto;
    }
    .line-row {
      display: grid; grid-template-columns: 2fr 1fr auto; gap: 10px;
      padding: 5px 0; font-size: 12px; border-bottom: 1px solid var(--ink-100);
    }
    .line-row:last-child { border-bottom: none; }
    .line-desc { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .num { text-align: right; }

    .total-row {
      display: flex; justify-content: flex-end; gap: 18px; font-size: 12px;
      border-top: var(--hairline); padding-top: 10px;
    }
    .total-row span strong { margin-left: 6px; }
    .total-big { font-size: 15px; color: var(--navy); }
    .total-big strong { font-size: 17px; }

    .scope { font-size: 12px; color: var(--ink-700); padding: 10px;
      background: var(--ink-50); border-radius: 6px; border-left: 2px solid var(--sky); }

    .review-actions {
      display: flex; justify-content: flex-end; gap: 8px; margin-top: auto;
      padding-top: 10px; border-top: var(--hairline);
    }
    .match-notes {
      font-size: 11px; color: var(--ink-500); padding: 8px 10px;
      background: var(--ink-50); border-radius: 6px; border-left: 2px solid var(--gold);
      font-family: var(--font-mono);
    }
    .raw-json {
      font-size: 11px; color: var(--ink-700); background: var(--ink-50);
      padding: 10px; border-radius: 6px; max-height: 300px; overflow: auto;
    }

    @media (max-width: 900px) {
      .review-body { grid-template-columns: 1fr; }
      .review-preview { min-height: 320px; }
    }
  `;
  document.head.appendChild(style);
}
