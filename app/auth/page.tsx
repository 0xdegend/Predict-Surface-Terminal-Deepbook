'use client';

/**
 * /auth — the OAuth callback target for Enoki zkLogin (the `redirectUrl` the
 * sign-in popup returns to). It must be SAME-ORIGIN and load instantly, with the
 * Enoki wallet registered (it is — the root layout wraps every route in
 * <Providers> → <RegisterEnokiWallets/>), so the SDK can read the id_token from
 * the URL, finish zkLogin, signal the opener, and close this popup.
 *
 * Deliberately NOT the home page: that route server-fetches the protocol snapshot
 * and mounts the 3-D surface, which renders blank for seconds inside a popup and
 * stalls the handshake. This page is client-only and trivial, so it resolves fast.
 */
export default function AuthCallback() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-bg-0 px-6 text-center">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-text-3 border-t-transparent" />
      <p className="font-sans text-[13px] text-text-2">Completing sign-in…</p>
      <p className="text-[11px] text-text-3">This window closes automatically.</p>
    </div>
  );
}
