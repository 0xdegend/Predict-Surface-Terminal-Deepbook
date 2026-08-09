/**
 * lib/sui/enoki-sponsor.ts — client side of Enoki gasless execution.
 *
 * `registerEnokiWallets` gives zkLogin AUTH only — its wallet builds with the
 * user's own address as gas owner and would need SUI. Sponsorship is a separate
 * flow, and Enoki's sponsor endpoints require the PRIVATE api key (the public key
 * 403s "Private API key required") — so the create/execute steps run on our
 * server route `/api/sponsor`. The browser only: builds the transaction KIND,
 * and signs the sponsored bytes with the zkLogin wallet.
 *
 *   1. build tx KIND (no gas)                  tx.build({ onlyTransactionKind })
 *   2. POST /api/sponsor (create)              → { bytes, digest }   [private key, server]
 *   3. zkLogin wallet signs the sponsored bytes  dAppKit.signTransaction(...)
 *   4. POST /api/sponsor (execute)             → { digest }          [private key, server]
 */
import { Transaction } from '@mysten/sui/transactions';
import { toBase64, fromBase64 } from '@mysten/sui/utils';
import { dAppKit } from '@/lib/sui/dapp-kit';
import { v2ReadClient } from '@/lib/sui/grpc';
import { enokiEnabled } from '@/config/enoki';

/** Sponsorship is wired whenever Enoki auth is configured; the server route
 *  holds the private key and does the actual sponsoring. */
export const sponsorshipAvailable = enokiEnabled;

async function postSponsor<T>(payload: unknown): Promise<T> {
  const res = await fetch('/api/sponsor', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Sponsor failed (${res.status})`);
  return data as T;
}

/**
 * An Enoki 4xx means the sponsored transaction was rejected BEFORE it reached the
 * chain — most often the gas reservation made at "create" expired during the
 * zkLogin signing step (a slow proof refresh), or an object version was briefly
 * stale. Because nothing executed, re-sponsoring fresh gas is safe (no
 * double-submit) and almost always clears it. A network / 5xx error is ambiguous
 * (Enoki may have submitted before the response was lost) and is NOT retried.
 */
function enokiRejectedPreChain(e: unknown): boolean {
  return e instanceof Error && /Enoki API failed \(status: 4\d\d\)/i.test(e.message);
}

/** create → zkLogin sign → execute, one attempt. The KIND bytes don't expire
 *  (only the sponsor's gas reservation does), so a retry reuses them and just
 *  re-sponsors fresh gas + re-signs (zkLogin signing is non-interactive). */
async function sponsorSignExecute(kindB64: string, sender: string, allowedAddresses?: string[]) {
  // 1) create the sponsored transaction (server, private key).
  const created = await postSponsor<{ bytes: string; digest: string }>({
    transactionKindBytes: kindB64,
    sender,
    allowedAddresses,
  });
  // 2) the zkLogin wallet signs the sponsored bytes (gas already attached).
  const { signature } = await dAppKit.signTransaction({
    transaction: Transaction.from(created.bytes),
  });
  // 3) execute (server, private key).
  try {
    const executed = await postSponsor<{ digest: string }>({ digest: created.digest, signature });
    return executed.digest;
  } catch (e) {
    // An execute-phase 5xx is ambiguous — Enoki may have submitted before its
    // response was lost (seen live 2026-07-08: their testnet execute endpoint
    // 502'd during the JSON-RPC shutdown). The final digest is fixed by the
    // sponsored bytes, so we can safely CHECK the chain instead of guessing:
    // if the tx landed, this attempt succeeded.
    if (/status: 5\d\d/.test(e instanceof Error ? e.message : '')) {
      const landed = await txLanded(created.digest);
      if (landed) return created.digest;
    }
    throw e;
  }
}

/** Minimal simulate surface — `dAppKit.getClient().core` (a gRPC core client)
 *  satisfies this; we narrow the result ourselves (below) rather than depend on
 *  the SDK's exact generic. */
interface SimulateCore {
  simulateTransaction: (opts: { transaction: Transaction; checksEnabled?: boolean }) => Promise<unknown>;
}

/** The only bit of a simulate result we read — a MoveAbort's raw message. */
interface SimFailure {
  $kind?: string;
  FailedTransaction?: { status?: { error?: { message?: string } | string | null } };
}

/**
 * Dry-run the sponsored kind bytes and return the raw Move abort message if the tx
 * would abort on-chain (null otherwise / on a transport hiccup).
 *
 * Why it exists: Enoki's `create` step dry-runs the tx to attach sponsor gas, but
 * when the tx would abort (an inadmissible leverage, a just-expired market, …) it
 * rejects with a GENERIC 4xx that HIDES the Move abort — so the trader would only
 * see "the gasless service briefly rejected the request, try again", which never
 * clears for a real, deterministic abort. This decodes the actual reason so the
 * caller's humanizer (`humanizeV2Error` reads exactly this message format) can show
 * plain, actionable copy.
 *
 * It used to run BEFORE every sponsor as a guard, which meant a second full simulate
 * (on top of Enoki's own) on the happy path of EVERY gasless trade — pure latency.
 * It now runs ONLY when Enoki rejects pre-chain, to tell a transient gas-reservation
 * expiry (retry) from a real abort (surface it, don't retry). We rebuild from the
 * sponsored KIND bytes (not the live tx object) so we validate exactly what Enoki ran.
 */
async function sponsoredKindAbort(core: SimulateCore, kindB64: string, sender: string): Promise<string | null> {
  try {
    const probe = Transaction.fromKind(fromBase64(kindB64));
    probe.setSender(sender);
    const res = (await core.simulateTransaction({ transaction: probe, checksEnabled: false })) as SimFailure;
    if (res.$kind === 'FailedTransaction') {
      const err = res.FailedTransaction?.status?.error;
      return (typeof err === 'string' ? err : err?.message) ?? null;
    }
  } catch {
    /* couldn't reach simulate — leave classification to the retry / Enoki */
  }
  return null;
}

/** Bounded on-chain lookup of a digest (a few seconds), false if not found. */
async function txLanded(digest: string): Promise<boolean> {
  try {
    const found = v2ReadClient()
      .core.waitForTransaction({ digest })
      .then(() => true);
    const timeout = new Promise<boolean>((r) => setTimeout(() => r(false), 8_000));
    return await Promise.race([found, timeout]);
  } catch {
    return false;
  }
}

/**
 * Sponsor + sign + execute `tx` gaslessly. Returns the executed digest. The
 * caller handles `waitForTransaction` + cache invalidation (runTx already does),
 * so this stays a thin transport. Retries once on a transient pre-chain Enoki
 * rejection (e.g. the sponsored tx expired while signing).
 */
export async function executeSponsored(
  tx: Transaction,
  sender: string,
  /** Addresses the sponsored tx may touch (e.g. a cash-out destination). */
  allowedAddresses?: string[],
): Promise<string> {
  // Health-aware client so the KIND build (which resolves the sender's coins) and
  // the dry-run run against a synced node, not a stalled primary fullnode.
  const client = v2ReadClient();
  // `coinWithBalance` resolves the sender's coins at build time, so the sender
  // must be set even for an onlyTransactionKind build (it's not serialized into
  // the kind — Enoki sets the real sender + gas when it sponsors).
  tx.setSenderIfNotSet(sender);
  // Only the transaction KIND — Enoki owns the gas object. Built once; a retry
  // re-sponsors fresh gas from these same bytes.
  const kindB64 = toBase64(await tx.build({ client, onlyTransactionKind: true }));

  // NO pre-emptive dry-run here: Enoki's create step already dry-runs to attach gas,
  // so a second simulate up front just added a full round trip to EVERY gasless
  // trade. We dry-run ONLY on an Enoki pre-chain rejection, to classify it (below).
  const MAX_ATTEMPTS = 2;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await sponsorSignExecute(kindB64, sender, allowedAddresses);
    } catch (e) {
      lastErr = e;
      // Raw failure in the browser console — the toast is humanized, but
      // debugging needs the phase + Enoki's exact words.
      console.error(`[enoki-sponsor] attempt ${attempt}/${MAX_ATTEMPTS} failed (sender ${sender}):`, e);
      if (enokiRejectedPreChain(e)) {
        // Enoki buries a deterministic Move abort behind the SAME generic 4xx it
        // uses for a transient gas-reservation expiry. Dry-run the same bytes to
        // tell them apart: a real abort → surface it now (retrying never clears a
        // deterministic abort); a clean sim → transient, so retry once.
        const abort = await sponsoredKindAbort(client.core, kindB64, sender);
        if (abort) throw new Error(abort);
        if (attempt < MAX_ATTEMPTS) continue;
      }
      throw e;
    }
  }
  throw lastErr;
}
