/**
 * lib/sui/v2/session-gas.ts — client transport for the session-gas drip faucet.
 *
 * Thin POST to /api/session-gas (the server holds the treasury key and enforces every
 * cap). Funds a delegated-session key's gas so it can self-fund its own trades — the
 * lowest-latency, popup-less path for BOTH Google and Slush users. Non-throwing: any
 * failure returns { ok: false } so the caller can fall back (Slush → owner-funded gas)
 * without a thrown error tearing down the arm flow.
 */

export interface SessionGasResult {
  /** True when the key is funded after this call (a drip landed, or it already had
   *  enough gas). False on any refusal/error — caller should fall back. */
  ok: boolean;
  /** Drip tx digest, or null when no tx was needed (already funded). */
  digest?: string | null;
  /** SUI dripped (MIST, @9dec string); '0' when already funded. */
  suiAmount: string;
  /** True when the key already held enough gas (no transfer done). */
  alreadyFunded?: boolean;
  /** Stable server reason on failure (e.g. 'treasury_empty', 'cooldown'). */
  code?: string;
}

/**
 * In-flight drips keyed by session address. A drip holds a server-side lock for its
 * whole life — including the several-second on-chain confirm — so a SECOND request for
 * the same key while the first is still confirming is rejected with a 409 ("already in
 * progress"). That second request should never be sent: a re-render, a retry, or a
 * follow-up trade landing before the first drip confirms would all fire it. Collapsing
 * overlapping calls onto ONE promise means both callers get the first drip's real
 * result (funded / already-funded) instead of a spurious 409. Cleared when it settles,
 * so a later legitimate re-fund (after the cooldown) still goes through.
 */
const inFlight = new Map<string, Promise<SessionGasResult>>();

/** Ask the treasury to top a session key up to its gas target. Never throws. */
export function dripSessionGas(address: string): Promise<SessionGasResult> {
  const pending = inFlight.get(address);
  if (pending) return pending;
  const p = requestDrip(address).finally(() => inFlight.delete(address));
  inFlight.set(address, p);
  return p;
}

/** The actual POST to /api/session-gas. Wrapped by dripSessionGas' in-flight dedup. */
async function requestDrip(address: string): Promise<SessionGasResult> {
  try {
    const res = await fetch('/api/session-gas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      digest?: string | null;
      suiAmount?: string;
      alreadyFunded?: boolean;
      code?: string;
    };
    if (!res.ok) return { ok: false, suiAmount: '0', code: data.code };
    return {
      ok: true,
      digest: data.digest ?? null,
      suiAmount: data.suiAmount ?? '0',
      alreadyFunded: data.alreadyFunded,
    };
  } catch {
    return { ok: false, suiAmount: '0', code: 'network' };
  }
}
