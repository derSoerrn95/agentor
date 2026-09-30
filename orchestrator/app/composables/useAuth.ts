import { createAuthClient } from 'better-auth/vue';
import { adminClient } from 'better-auth/client/plugins';
import { passkeyClient } from '@better-auth/passkey/client';
import { oauthProviderClient } from '@better-auth/oauth-provider/client';

const client = createAuthClient({
  baseURL: typeof window !== 'undefined' ? window.location.origin : '',
  // oauthProviderClient: on the login / consent pages of an OAuth (MCP)
  // authorization, forwards the signed authorization query with every auth
  // request so better-auth can resume the flow and redirect back to the client.
  plugins: [adminClient(), passkeyClient(), oauthProviderClient()],
});

/** True on a page reached through an OAuth authorization redirect (the
 * authorize endpoint appends a signed query carrying `sig`). */
export function isOAuthAuthorizationPage(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('sig');
}

/** Follows the `{ redirect, url }` body better-auth returns when an auth call
 * continues an OAuth authorization. Returns false when there is nothing to follow. */
export function followOAuthRedirect(data: unknown): boolean {
  const body = data as { redirect?: boolean; url?: string } | null | undefined;
  if (!body?.redirect || !body.url || typeof window === 'undefined') return false;
  window.location.href = body.url;
  return true;
}

export function useAuth() {
  const session = client.useSession();

  const user = computed(() => session.value?.data?.user);
  const isLoggedIn = computed(() => !!session.value?.data);
  const isAdmin = computed(() => (user.value as any)?.role === 'admin');
  const isLoading = computed(() => session.value?.isPending ?? false);

  async function signIn(email: string, password: string) {
    return client.signIn.email({ email, password });
  }

  async function signOut() {
    await client.signOut();
    // Force-reload to wipe client state and re-evaluate route guards
    if (typeof window !== 'undefined') window.location.href = '/login';
  }

  return {
    client,
    session,
    user,
    isLoggedIn,
    isAdmin,
    isLoading,
    signIn,
    signOut,
  };
}
