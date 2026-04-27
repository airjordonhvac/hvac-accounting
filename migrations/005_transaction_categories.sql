-- =============================================================================
-- 005_transaction_categories.sql
-- Adds personal-style transaction categories (Restaurants, Gas, Software, etc.)
-- separate from the COA. Used primarily for credit card transaction tagging
-- so end-of-year tax export rolls up cleanly.
--
-- Design:
-- - transaction_categories: 12 default buckets, user-editable
-- - categorization_rules: keyword -> category mappings, applied on tx insert
--   and via "apply rules retroactively" button
-- - bank_transactions.category_id: new FK to transaction_categories
--   (existing category_account_id stays for COA mapping at year-end)
-- =============================================================================

-- 1. Categories table
create table if not exists transaction_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  display_order int not null default 100,
  color text,                          -- hex like '#7B9DD6' for chart consistency
  coa_account_id uuid references chart_of_accounts(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_tx_categories_active on transaction_categories(is_active, display_order);

-- 2. Categorization rules table
create table if not exists categorization_rules (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references transaction_categories(id) on delete cascade,
  -- match_text is a substring (case-insensitive) of the description that triggers the rule
  match_text text not null,
  match_type text not null default 'contains' check (match_type in ('contains','starts_with','exact')),
  priority int not null default 100,   -- lower wins on tie
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references user_profiles(id)
);

create index if not exists idx_cat_rules_active on categorization_rules(is_active, priority);
create index if not exists idx_cat_rules_match_text on categorization_rules(lower(match_text));

-- 3. Add category_id to bank_transactions (separate from existing category_account_id)
alter table bank_transactions
  add column if not exists category_id uuid references transaction_categories(id) on delete set null;

create index if not exists idx_bank_tx_category on bank_transactions(category_id);

-- 4. Seed the 12 default categories
insert into transaction_categories (name, display_order, color) values
  ('Restaurants & Dining',     10, '#E25C5C'),
  ('Gas & Fuel',               20, '#F4A03A'),
  ('Office Supplies',          30, '#7B9DD6'),
  ('Travel',                   40, '#9B7BD6'),
  ('Utilities',                50, '#5DA877'),
  ('Software & Subscriptions', 60, '#4A8CB8'),
  ('Insurance',                70, '#B85A8C'),
  ('Equipment & Tools',        80, '#D4A04A'),
  ('Materials & Supplies',     90, '#C97A4A'),
  ('Vehicle Maintenance',     100, '#7AAFB8'),
  ('Professional Services',   110, '#6B8E5A'),
  ('Bank Fees',               120, '#A86B6B'),
  ('Other',                   999, '#8E8E8E')
on conflict (name) do nothing;

-- 5. RLS policies
alter table transaction_categories enable row level security;
alter table categorization_rules enable row level security;

drop policy if exists "categories_read_all" on transaction_categories;
create policy "categories_read_all" on transaction_categories
  for select using (auth.uid() is not null);

drop policy if exists "categories_admin_write" on transaction_categories;
create policy "categories_admin_write" on transaction_categories
  for all using (is_admin()) with check (is_admin());

drop policy if exists "rules_read_all" on categorization_rules;
create policy "rules_read_all" on categorization_rules
  for select using (auth.uid() is not null);

drop policy if exists "rules_admin_write" on categorization_rules;
create policy "rules_admin_write" on categorization_rules
  for all using (is_admin()) with check (is_admin());

-- 6. Helper function: apply rules to a single tx description, return matched category_id or null
create or replace function categorize_description(desc_text text)
returns uuid
language plpgsql
stable
as $$
declare
  matched uuid;
begin
  select cr.category_id into matched
  from categorization_rules cr
  where cr.is_active = true
    and (
      (cr.match_type = 'contains'    and lower(desc_text) like '%' || lower(cr.match_text) || '%') or
      (cr.match_type = 'starts_with' and lower(desc_text) like lower(cr.match_text) || '%') or
      (cr.match_type = 'exact'       and lower(desc_text) = lower(cr.match_text))
    )
  order by cr.priority asc, length(cr.match_text) desc
  limit 1;
  return matched;
end;
$$;

-- 7. Trigger: auto-categorize new bank_transactions on insert
create or replace function bank_tx_auto_categorize()
returns trigger
language plpgsql
as $$
begin
  if new.category_id is null and new.description is not null then
    new.category_id := categorize_description(new.description);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_bank_tx_auto_categorize on bank_transactions;
create trigger trg_bank_tx_auto_categorize
  before insert on bank_transactions
  for each row execute function bank_tx_auto_categorize();
