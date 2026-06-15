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

/** Request a starter grant for `address`. Resolves with the executed digest and
 *  the amount paid (base units, @6dec as a string). Throws StarterGrantError. */
export async function claimStarterGrant(
  address: string,
): Promise<{ digest: string; amount: string }> {
  const res = await fetch('/api/starter-grant', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    digest?: string;
    amount?: string;
    error?: string;
    code?: string;
  };
  if (!res.ok || !data.digest) {
    throw new StarterGrantError(data.error ?? `Grant failed (${res.status})`, data.code);
  }
  return { digest: data.digest, amount: data.amount ?? '0' };
}
