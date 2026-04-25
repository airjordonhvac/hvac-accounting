# Air Jordon HVAC — Internal Accounting

Single-company internal accounting app. Invoicing/AR, bill pay/AP, bank reconciliation, 1099 tracking, and an AI-powered document inbox that auto-extracts bills, contracts, bank statements, and W-9s.

**Stack:** vanilla JS (no build step) + Supabase (Postgres, Auth, Storage, Edge Functions) + Anthropic API (document extraction).

**Hosting:** GitHub Pages.

---

## What's in the box

```
hvac-accounting/
├── index.html                    Single-page entry
├── config.js                     Supabase anon key (edit before deploy)
├── assets/styles.css             Brand styling (navy/sky/gold, Bebas Neue)
├── lib/
│   ├── app.js                    Bootstrap, auth, route registration
│   ├── supabase.js               Supabase client singleton
│   ├── auth.js                   Magic-link sign-in, profile loading
│   ├── router.js                 Hash-based router
│   ├── toast.js                  Toast notifications
│   ├── modal.js                  Confirm dialogs
│   └── format.js                 Money/date formatters
├── modules/
│   ├── dashboard.js              6 stat cards + 90-day cash flow sparkline
│   ├── inbox.js                  Document upload + approval queue
│   ├── materialize.js            Approval → real record creation
│   └── stubs.js                  Placeholder pages for unbuilt modules
├── migrations/
│   ├── 001_initial.sql           Tables, COA, RLS, audit triggers
│   ├── 002_retainage_and_tax_id_mask.sql
│   └── 003_document_extraction.sql
├── seed.sql                      Sample data for first-run testing
├── supabase/functions/extract/
│   └── index.ts                  Edge Function: Claude API extraction
├── preview.html                  Self-contained mock preview (no DB needed)
├── README.md                     This file
└── deploy.md                     Step-by-step deploy guide
```

---

## Architecture in plain English

**Data flow:**

1. User drops a PDF/photo into the **Inbox** drop zone.
2. Browser uploads file to Supabase Storage (`extraction-queue` bucket).
3. Browser inserts a `documents` row, then invokes the **`extract` Edge Function**.
4. Edge Function (server-side, holds the Anthropic API key) downloads the file, calls **Claude Sonnet 4.6** with a doc-type-specific prompt, gets back structured JSON.
5. Edge Function runs a **rules-based matching pass** against existing vendors, customers, projects, and chart of accounts via `pg_trgm` fuzzy matching.
6. Edge Function writes a `pending_entries` row with the raw extraction + matched candidates and updates the document status to `pending`.
7. **Inbox UI** shows the pending entry side-by-side with a PDF preview. Admin clicks Approve.
8. **Materialization** (`modules/materialize.js`) creates the real record — `bills` + `bill_lines`, `projects`, `import_batches` + `bank_transactions`, or vendor update.

**Auth:** Supabase magic link → user must have a row in `user_profiles` with role `admin` or `crew` to enter the app.

**RLS:** every table has policies. Admin = full CRUD. Crew = read most things, write bills only on their assigned projects, no access to AR / payments / bank / 1099.

**Audit log:** every write on every user table goes through a generic Postgres trigger that captures `before/after` JSON to `audit_log`. Append-only — no client write policy.

**Document storage:** three Supabase Storage buckets — `w9-documents` (admin only), `bill-attachments` (staff write, admin delete), `invoice-pdfs` (public read, admin write), and `extraction-queue` (staff write, admin delete).

---

## Quickstart (5 minutes if you've followed deploy.md)

1. **Run the migrations** in Supabase SQL Editor in order: 001 → 002 → 003.
2. **(Optional)** Run `seed.sql` to load 20 sample records so the dashboard isn't empty on first load.
3. **Deploy the Edge Function** via Supabase Dashboard → Edge Functions → New Function. Name it `extract`, paste `supabase/functions/extract/index.ts`, deploy. Set `ANTHROPIC_API_KEY` in Edge Functions secrets.
4. **Edit `config.js`** with your Supabase anon key.
5. **Push to GitHub** at `airjordonhvac/hvac-accounting`, enable GitHub Pages.
6. **Sign in** with magic link, then run this SQL once to bootstrap your admin profile:
   ```sql
   insert into user_profiles (id, email, full_name, role)
   values (
     (select id from auth.users where email = 'YOUR@EMAIL.COM'),
     'YOUR@EMAIL.COM',
     'Jordon Biagas',
     'admin'
   );
   ```

For the full step-by-step including screenshots-of-text-style guidance, see **[`deploy.md`](deploy.md)**.

---

## Adding crew users

After they sign in once and hit the "no profile" screen, run:

```sql
insert into user_profiles (id, email, full_name, role)
values (
  (select id from auth.users where email = 'CREW@EMAIL.COM'),
  'CREW@EMAIL.COM',
  'Crew Member Name',
  'crew'
);
```

Then assign them to projects so they can enter bills against those projects:

```sql
insert into project_assignments (project_id, user_id)
values (
  (select id from projects where project_number = '2026-001'),
  (select id from user_profiles where email = 'CREW@EMAIL.COM')
);
```

Crew users see only Dashboard, Inbox, Customers, Vendors, Projects, and Bills in the sidebar. Their drop-zone uploads go straight into the pending queue for admin review — they never see AR or 1099 numbers.

---

## What's built vs. what's stubbed

| Module | Status |
|---|---|
| Dashboard (6 cards + cash flow chart) | ✅ Live queries |
| Inbox (upload, extraction, approval) | ✅ End-to-end |
| Materialization (approve → real record) | ✅ All 4 doc types |
| Customers / Vendors / Projects (full CRUD) | 🟡 Stub pages, data created via Inbox approvals |
| Invoices (create, edit, PDF, aging) | 🟡 Stub |
| Bills (manual entry beyond Inbox) | 🟡 Stub — Inbox creates bills, no manual create UI yet |
| Bank import (CSV/OFX) | 🟡 Stub — Inbox handles PDF statements, no CSV yet |
| Reconciliation UI | 🟡 Stub — schema is ready, UI is next |
| Reports (P&L, aging detail) | 🟡 Stub |
| 1099 detail page (dashboard card works) | 🟡 Stub |
| Settings (user mgmt, year close, audit viewer) | 🟡 Stub |

**Strategy: Inbox-first.** Once the document pipeline is working in production, most data enters through there. The CRUD pages then become "browse what came in" rather than "type everything from scratch." That's why we built Inbox before the manual-entry forms.

---

## Known security caveats

- **`vendors.tax_id_encrypted` column is bytea but not yet encrypted** at the DB level. Plaintext bytes are stored. Migration 004 (planned) will use `pgp_sym_encrypt` with a Supabase Vault secret. Until then: same effective security as QuickBooks Desktop on a local machine — admin-only RLS, but unencrypted at rest. **If you must store tax IDs encrypted today**, leave the column null and keep W-9 PDFs as the source of truth.
- **Materialization is application-code, not a DB trigger.** Admin manually flipping `pending_entries.status = 'approved'` in SQL won't create a real record. The `healOrphans()` background task in `app.js` re-runs materialization for orphaned approvals, but only when the app is loaded. For higher integrity, the next iteration could move materialization into a Postgres function.
- **Service role key is in Supabase environment, not the client.** The browser only ever holds the anon key. Edge Functions use the service role to bypass RLS for server-side writes (creating pending_entries, updating documents).

---

## Costs

- **Supabase Free tier** covers this app comfortably for one shop. Edge Function invocations and Storage bandwidth stay well under free-tier limits at expected volume (~50 docs/week).
- **Anthropic API** — Sonnet 4.6 at vision pricing. Per-document cost roughly: vendor invoice ~$0.01-0.02, bank statement (multi-page PDF) ~$0.05-0.10. Set a $25/month usage alert in the Anthropic console.
- **GitHub Pages** is free for public repos.

---

## Troubleshooting

**"No profile" after magic link.**
You signed in but no `user_profiles` row exists. Run the bootstrap SQL above.

**Inbox upload says "extracting" forever.**
The Edge Function failed silently. Check Supabase Dashboard → Edge Functions → Logs for the `extract` function. Most common cause: `ANTHROPIC_API_KEY` secret not set or invalid.

**"Bank account not found for last4 X".**
You uploaded a bank statement before adding the corresponding bank account. Add it via Settings → Bank Accounts (when built) or directly via SQL:
```sql
insert into bank_accounts (name, institution, last4, account_type)
values ('Chase Operating', 'JPMorgan Chase', '4721', 'checking');
```

**Approve button does nothing for crew users.**
By design — only admins approve. Crew uploads, admin reviews.

**Dashboard cards show all zeros.**
Either you haven't loaded `seed.sql` and haven't entered data yet, or RLS is filtering out everything because your `user_profiles.role` isn't set. Check with:
```sql
select * from user_profiles where email = 'YOUR@EMAIL';
```

---

## Roadmap (in priority order)

1. Customers / Vendors / Projects CRUD pages
2. Invoices module (full create/edit + jsPDF generation + aging)
3. Bills module (manual entry + payment runs)
4. Bank CSV/OFX import (Chase, Capital One, generic)
5. Reconciliation UI with auto-match engine
6. 1099 detail page + IRS-format CSV export
7. P&L and AR/AP aging reports
8. Settings (user mgmt, year-end lock, audit log viewer)
9. Migration 004: `tax_id` encryption via `pgp_sym_encrypt`
10. Recurring bills generator (utilities, rent, subscriptions)

---

## License

Internal use only. Air Jordon HVAC LLC.
