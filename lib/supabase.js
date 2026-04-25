// =============================================================================
// Supabase client
// -----------------------------------------------------------------------------
// Single instance used by the whole app. Keys are public (anon) — the anon
// key is safe in a client, RLS is what actually protects the data.
//
// Using esm.sh so there's no build step.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = 'https://zottjoyiczglrkaodjfr.supabase.co';
const SUPABASE_ANON_KEY = window.__AJ_SUPABASE_ANON_KEY__ || ''; // set in config.js

if (!SUPABASE_ANON_KEY) {
  console.warn('[supabase] No anon key found. Set window.__AJ_SUPABASE_ANON_KEY__ in config.js.');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true, // catches the magic-link hash callback
  }
});

// Convenience: tiny wrapper that throws on error so callers can `await` normally.
// Use the raw `supabase` client when you need to inspect error objects.
export async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}
