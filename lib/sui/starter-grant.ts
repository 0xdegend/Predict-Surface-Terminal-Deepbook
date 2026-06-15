/**
 * lib/sui/starter-grant.ts — client transport for the app-run DUSDC drip faucet.
 *
 * Thin POST to /api/starter-grant (the server holds the treasury key and enforces
 * every cap). The caller refetches the wallet balance on success and falls back
 * to the public faucet link on any failure. See config/starter-grant.ts.
 */

export class StarterGrantError extends Error {
  /** Stable reason from the server (e.g. 'treasury_empty', 'rate_limited'). */
  code: string;
  constructor(message: string, code = 'error') {
    super(message);
    this.name = 'StarterGrantError';
    this.code = code;
  }
}

/**
 * Request a starter grant for `address`. `includeSui` asks the server to also
 * drip a little gas SUI — pass true ONLY for external wallets (Google/zkLogin is
 * gasless, so they never need it); the server still gates on actual SUI balance.
 * Resolves with the executed digest, the DUSDC paid, and the SUI dripped (all
 * base-unit strings — DUSDC @6dec, SUI @9dec/MIST). Throws StarterGrantError.
 */
export async function claimStarterGrant(
  address: string,
  includeSui: boolean,
): Promise<{ digest: string; amount: string; suiAmount: string }> {
  const res = await fetch('/api/starter-grant', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, includeSui }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    digest?: string;
    amount?: string;
    suiAmount?: string;
    error?: string;
    code?: string;
  };
  if (!res.ok || !data.digest) {
    throw new StarterGrantError(data.error ?? `Grant failed (${res.status})`, data.code);
  }
  return { digest: data.digest, amount: data.amount ?? '0', suiAmount: data.suiAmount ?? '0' };
}
