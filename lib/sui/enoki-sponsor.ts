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
import { toBase64 } from '@mysten/sui/utils';
import { dAppKit } from '@/lib/sui/dapp-kit';
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
  const executed = await postSponsor<{ digest: string }>({ digest: created.digest, signature });
  return executed.digest;
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
  const client = dAppKit.getClient();
  // `coinWithBalance` resolves the sender's coins at build time, so the sender
  // must be set even for an onlyTransactionKind build (it's not serialized into
  // the kind — Enoki sets the real sender + gas when it sponsors).
  tx.setSenderIfNotSet(sender);
  // Only the transaction KIND — Enoki owns the gas object. Built once; a retry
  // re-sponsors fresh gas from these same bytes.
  const kindB64 = toBase64(await tx.build({ client, onlyTransactionKind: true }));

  const MAX_ATTEMPTS = 2;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await sponsorSignExecute(kindB64, sender, allowedAddresses);
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS && enokiRejectedPreChain(e)) continue;
      throw e;
    }
  }
  throw lastErr;
}
