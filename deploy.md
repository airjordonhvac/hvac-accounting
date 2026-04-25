# Deploy Guide

End-to-end, in order. Total time: ~20 minutes if nothing goes wrong.

> **Prereqs.** A Supabase project (already exists at `zottjoyiczglrkaodjfr`), an Anthropic API key (already created and stored — you rotated it earlier), a GitHub account with access to the `airjordonhvac` org.

---

## Phase 1 — Database (5 minutes)

### 1.1 Run the migrations

Go to https://supabase.com/dashboard/project/zottjoyiczglrkaodjfr/sql/new

Run each migration file as a separate query, **in this order**:

1. **`migrations/001_initial.sql`** — creates 20 tables, COA seed (47 accounts), RLS, audit triggers, storage buckets. Should complete in 2-3 seconds.
2. **`migrations/002_retainage_and_tax_id_mask.sql`** — drops bills.retainage column, creates `v_vendors` masked view.
3. **`migrations/003_document_extraction.sql`** — adds documents, pending_entries, reconciliation_conflicts tables + extraction infrastructure.

After each one, look for `Success. No rows returned`. If you see an error, **stop and read it** — usually a typo in copy-paste, occasionally an extension that needs enabling.

### 1.2 Load seed data (optional but recommended)

Run **`seed.sql`** to load 20 sample records (5 customers, 10 vendors, 5 projects, a handful of invoices and bills). This makes the dashboard show real numbers on first load instead of zeros. You can clear it later by truncating those tables.

> **Note.** Seed data uses fake project numbers and vendor names. Don't ship to production with seed data still loaded — clean up before going live.

---

## Phase 2 — Edge Function (5 minutes)

This is the server-side code that holds your Anthropic API key and calls Claude. It runs on Supabase's infrastructure, not in the browser.

### 2.1 Create the function

1. Go to https://supabase.com/dashboard/project/zottjoyiczglrkaodjfr/functions
2. Click **Deploy a new function** (or **New function**, depending on UI version)
3. Function name: **`extract`** (must match exactly — the app calls `supabase.functions.invoke('extract', ...)`)
4. Paste the entire contents of `supabase/functions/extract/index.ts` into the editor
5. Click **Deploy function**

Wait ~30 seconds for deployment to finish. You should see a green checkmark and a function URL.

### 2.2 Set the API key secret

Still on the Edge Functions page:

1. Click the **Secrets** tab (or Settings → Edge Functions → Secrets)
2. Click **Add new secret**
3. Name: **`ANTHROPIC_API_KEY`** (exact case)
4. Value: paste your Anthropic API key (the new one you created after rotating)
5. Save

The Edge Function reads it via `Deno.env.get('ANTHROPIC_API_KEY')`. The key never touches the browser, never appears in network requests, never leaves Supabase.

> **Heads up:** the `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` env vars are auto-injected by Supabase — you don't set those manually.

### 2.3 Sanity check

In the Edge Functions UI, find the `extract` function and click **Logs**. Keep this tab open — when you upload your first doc later, you'll see the extraction call appear in real time.

---

## Phase 3 — Get the anon key (1 minute)

1. Go to https://supabase.com/dashboard/project/zottjoyiczglrkaodjfr/settings/api
2. Find the **Project API keys** section
3. Copy the **`anon` `public`** key (the long `eyJ...` string — NOT the `service_role` key)
4. Open `config.js` in this repo
5. Replace `REPLACE_WITH_SUPABASE_ANON_KEY` with the value
6. Save

**The anon key is safe to commit to the repo.** RLS is what actually protects data — the anon key just lets the browser talk to your project. Do **NOT** commit the `service_role` key — that one bypasses RLS.

---

## Phase 4 — GitHub Pages (5 minutes)

### 4.1 Create the repo

1. Go to https://github.com/organizations/airjordonhvac/repositories/new
2. Repository name: **`hvac-accounting`**
3. Visibility: **Public** (required for free GitHub Pages; alternative is GitHub Pro for private)
4. Initialize with: **leave unchecked** (we're pushing existing files)
5. Create

### 4.2 Push files

Two paths — pick whichever fits your workflow.

**Path A — Drag and drop in the GitHub UI (no CLI needed):**

1. On the new empty repo page, click **uploading an existing file**
2. Drag the entire contents of this folder (NOT the folder itself — the files and subfolders inside) into the upload area
3. Wait for all files to upload (you'll see them listed)
4. Commit message: `Initial deploy`
5. Click **Commit changes**

**Path B — Claude in Chrome blob→tree→commit→ref pattern** (matches your existing workflow for hvac-takeoff and hvac-financials):

Open Claude in Chrome on this repo's GitHub page and tell it to push every file from the local folder using the GitHub API blob/tree/commit/ref pattern. Same flow you've used before.

### 4.3 Enable Pages

1. In the repo, go to **Settings → Pages** (left sidebar)
2. Under **Build and deployment**:
   - Source: **Deploy from a branch**
   - Branch: **`main`** / folder: **`/ (root)`**
3. Save

GitHub will start building. Wait ~60 seconds, then your app will be live at:

**`https://airjordonhvac.github.io/hvac-accounting/`**

The first build can take up to 5 minutes. Subsequent pushes deploy in ~30 seconds.

---

## Phase 5 — First sign-in (2 minutes)

### 5.1 Sign in via magic link

1. Open the live URL: `https://airjordonhvac.github.io/hvac-accounting/`
2. The login screen appears with the gold-bar Air Jordon branding
3. Enter your email, click **Send magic link**
4. Check your inbox (the email comes from Supabase, subject "Confirm your sign in" or similar)
5. Click the link in the email — it bounces you back to the live URL with a session

You'll see a brief loading splash, then the login card again with an error message: **"No profile — contact admin."** That's expected. We need to bootstrap your admin profile.

### 5.2 Bootstrap the admin profile

Back in Supabase SQL Editor:

```sql
insert into user_profiles (id, email, full_name, role)
values (
  (select id from auth.users where email = 'YOUR@EMAIL.COM'),
  'YOUR@EMAIL.COM',
  'Jordon Biagas',
  'admin'
);
```

Replace `YOUR@EMAIL.COM` with the email you used. Run.

### 5.3 Reload

Reload the live URL. You should now see the full app — sidebar with Dashboard / Inbox / Customers / Vendors / etc. — and your name+admin badge in the bottom-left corner.

If you loaded `seed.sql` in Phase 1.2, the dashboard cards will show real numbers. If not, everything is `$0.00` until you start using it.

---

## Phase 6 — Smoke tests (5 minutes)

### 6.1 Dashboard loads

Visit `#/dashboard`. All 6 cards should render. The cash flow sparkline should show a line (flat at zero if no payment data).

### 6.2 Inbox upload works

1. Visit `#/inbox`
2. Drop any PDF (a real vendor invoice if you have one handy, or anything to test)
3. The upload zone should briefly highlight gold, then a toast: *"X uploaded — extracting..."*
4. Switch to the **Processing** tab — your doc should appear with status `Extracting`
5. Wait 5-15 seconds (Claude API call latency varies with PDF size)
6. Switch to **Pending** tab — your doc should be there with extracted fields, side-by-side with the PDF

### 6.3 If extraction fails

Symptoms: doc stuck on `Extracting` for >2 minutes, or status flips to `failed` in the Processing tab.

Check Supabase → Edge Functions → `extract` → Logs. Common errors:

| Error in logs | Fix |
|---|---|
| `ANTHROPIC_API_KEY not configured` | Re-do Phase 2.2 |
| `Claude API 401: invalid x-api-key` | Wrong key, or key was revoked. Generate a new one and re-do Phase 2.2 |
| `Claude API 429: rate_limit` | Hit Anthropic rate limit. Wait a minute, try again. |
| `File download failed` | Storage bucket policy issue. Check that `extraction-queue` bucket exists (migration 003 creates it) |
| `JSON parse failed` | Claude returned non-JSON output. Usually means a bad prompt; the doc may not be a valid bill/contract. Reject it from the inbox. |

### 6.4 Approval creates a real record

1. On a pending entry in the inbox, click **Approve & Save**
2. Confirmation dialog shows what's about to happen ("Will create new vendor: X" if no match)
3. Confirm
4. Toast: *"Bill created"* (or appropriate type)
5. Verify in Supabase Table Editor: a new row exists in `bills` with the correct vendor, project, line items

If the toast says *"Approval failed: <error>"*, read the error. Most common cause: bank account not configured (for bank statements) — see README troubleshooting.

---

## Phase 7 — Add crew users (optional, 2 minutes per user)

For each crew member:

1. They visit the live URL and sign in via magic link
2. They hit "no profile" — that's expected
3. You run in SQL editor:

```sql
insert into user_profiles (id, email, full_name, role)
values (
  (select id from auth.users where email = 'CREW@EMAIL.COM'),
  'CREW@EMAIL.COM',
  'Their Name',
  'crew'
);
```

4. (Optional) Assign them to projects so they can enter bills against those jobs:

```sql
insert into project_assignments (project_id, user_id)
values (
  (select id from projects where project_number = '2026-001'),
  (select id from user_profiles where email = 'CREW@EMAIL.COM')
);
```

5. They reload — they're in. Sidebar shows only Dashboard / Inbox / Customers / Vendors / Projects / Bills (admin-only items hidden).

---

## Phase 8 — Re-deploys

Anytime you change app code, push to GitHub `main`. Pages rebuilds automatically in ~30 seconds.

For Edge Function changes: redeploy via Supabase Dashboard (paste new code, click Deploy). Or if you set up the Supabase CLI later, it's `supabase functions deploy extract`.

For schema changes: write a new migration `migrations/004_*.sql`, run it in SQL editor. Never edit existing migrations once they've been applied — append.

---

## Backups

Supabase has automatic daily backups on paid plans. On the free tier, take a manual snapshot at the start of every month:

1. Supabase → Database → Backups
2. **Create backup** (or use `pg_dump` via the connection string in Settings → Database)
3. Save the dump file somewhere safe (1Password, encrypted external drive, etc.)

For a single-shop accounting app, monthly backups are usually enough. After year-end close, take an extra backup before any further edits.

---

## Going live checklist

Before relying on this for real bookkeeping:

- [ ] All three migrations ran clean
- [ ] Edge Function deployed and `ANTHROPIC_API_KEY` secret set
- [ ] Tested the full Inbox flow with a real document and approved it
- [ ] Verified the approved record appears correctly in Supabase Table Editor
- [ ] Audit log has entries (check `select count(*) from audit_log`)
- [ ] Anthropic Console budget alert set ($25/month recommended)
- [ ] **Cleared seed data** if you loaded it — `delete from invoices; delete from bills; delete from projects; delete from customers where company in ('JM Stitt', 'Yum! Brands', 'Eyemart Express', 'WellMed', 'CBRE'); delete from vendors where name in (... seeded names ...);` — or simpler: re-run migrations 001-003 on a fresh project
- [ ] Bank accounts created for each real bank/CC/LOC you'll be uploading statements for (otherwise statement extraction will fail at materialization)
- [ ] First admin user has profile row
- [ ] Crew users (if any) have profile rows + project assignments

Once those are checked, you're live.
