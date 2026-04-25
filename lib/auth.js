// =============================================================================
// Auth
// -----------------------------------------------------------------------------
// Handles:
//   - magic-link sign in
//   - session restoration on page load
//   - loading the user's profile (role: admin/crew) from user_profiles
//   - sign out
//
// The rest of the app consults `getCurrentUser()` and `isAdmin()` to gate UI.
// =============================================================================

import { supabase, q } from './supabase.js';
import { toast } from './toast.js';

let currentUser = null;   // { id, email, full_name, role, is_active }

/**
 * Send a magic link to the given email. Supabase emails the link; clicking it
 * redirects back to this app with the session fragment in the URL, which
 * detectSessionInUrl picks up automatically.
 */
export async function sendMagicLink(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      // Redirect back to the app's root — works for both local dev and GH Pages.
      emailRedirectTo: window.location.origin + window.location.pathname,
    },
  });
  if (error) throw error;
}

/**
 * Load the profile row for the currently signed-in auth user.
 * Returns null if not signed in or no profile row exists.
 *
 * If the auth user has no profile row, we DO NOT auto-create one. An admin
 * has to insert the profile row manually (see README). This is a deliberate
 * guard: in a single-company internal tool, the signup step should be
 * controlled — we don't want strangers who guess the URL and magic-link
 * themselves in to get an automatic 'crew' role.
 */
export async function loadCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { currentUser = null; return null; }

  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, email, full_name, role, is_active')
    .eq('id', user.id)
    .maybeSingle();

  if (error) {
    console.error('[auth] profile load error:', error);
    currentUser = null;
    return null;
  }
  if (!data) {
    // Signed in but no profile — treat as unauthorized.
    console.warn('[auth] authenticated user has no profile row:', user.email);
    currentUser = null;
    return null;
  }
  if (!data.is_active) {
    currentUser = null;
    return null;
  }

  currentUser = data;
  return currentUser;
}

export function getCurrentUser() { return currentUser; }
export function isAdmin() { return currentUser?.role === 'admin'; }
export function isCrew() { return currentUser?.role === 'crew'; }

export async function signOut() {
  await supabase.auth.signOut();
  currentUser = null;
  window.location.hash = '';
  window.location.reload();
}

/**
 * Subscribe to auth state changes. Called once during bootstrap so that if
 * the user signs out in another tab, this tab reacts.
 */
export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange((event, session) => {
    callback(event, session);
  });
}
