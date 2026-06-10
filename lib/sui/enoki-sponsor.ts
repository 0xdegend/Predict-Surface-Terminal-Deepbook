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
 * Sponsor + sign + execute `tx` gaslessly. Returns the executed digest. The
 * caller handles `waitForTransaction` + cache invalidation (runTx already does),
 * so this stays a thin transport.
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
  // Only the transaction KIND — Enoki owns the gas object.
  const kindBytes = await tx.build({ client, onlyTransactionKind: true });

  // 1) create the sponsored transaction (server, private key).
  const created = await postSponsor<{ bytes: string; digest: string }>({
    transactionKindBytes: toBase64(kindBytes),
    sender,
    allowedAddresses,
  });

  // 2) the zkLogin wallet signs the sponsored bytes (gas already attached).
  const { signature } = await dAppKit.signTransaction({
    transaction: Transaction.from(created.bytes),
  });

  // 3) execute (server, private key).
  const executed = await postSponsor<{ digest: string }>({
    digest: created.digest,
    signature,
  });
  return executed.digest;
}
