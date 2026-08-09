/**
 * lib/sui/v2/lp-queue.ts — read the vault's PENDING LP queues from chain.
 *
 * v2 liquidity is async: `request_supply` / `request_withdraw` escrow the funds and
 * park a request in a FIFO queue; the keeper's flush fills them at NAV. Until a
 * flush runs, the money is in escrow — it is NOT yet PLP shares (and a queued
 * withdraw's shares are already burned-in-waiting), so `Remove` can't touch it.
 * The only way out before the flush is `cancel_supply_request(index)` /
 * `cancel_withdraw_request(index)` — which need the request's queue INDEX.
 *
 * Why chain and not the indexer: the beta indexer serves `/vaults/:id/supply-requests`
 * and `/supply-fills`, but exposes NO route for the `RequestCancelled` event (verified
 * 2026-07-13 — every plausible path 404s). A queue derived from requests-minus-fills
 * would therefore keep showing a cancelled request as pending forever. The chain's
 * queue pages are the only source that can't drift.
 *
 * `plp` exposes no view that enumerates the queue (only the `supply_requests_pending`
 * / `withdraw_requests_pending` counts), so we read the raw `lp_book::RequestPage`
 * pages out of the queue's Table and BCS-decode them.
 */
import { bcs } from '@mysten/sui/bcs';
import { predictV2Config } from '@/config/predict';

/**
 * `lp_book::RequestEntry` — field ORDER matters and is NOT the (alphabetical) order
 * the JSON shim prints. Verified byte-exactly against the live 8-06 queue via the
 * package's normalized Move struct: a 96-byte entry (index + account + recipient +
 * amount + min_output + missed_flushes).
 *
 * `account_id` is a Move `ID` (0x2::object::ID), which BCS-encodes as a bare 32-byte
 * address — so `bcs.Address` reads it exactly. `min_output` / `missed_flushes` were
 * ADDED by the 8-06 protocol (the earlier struct was 80 bytes); we don't use them,
 * but they MUST be modelled or every entry after the first misaligns and the amounts
 * decode to garbage — which is exactly the reconciliation failure this fixes.
 */
const RequestEntry = bcs.struct('RequestEntry', {
  index: bcs.u64(),
  account_id: bcs.Address,
  recipient: bcs.Address,
  amount: bcs.u64(),
  min_output: bcs.u64(),
  missed_flushes: bcs.u64(),
});

/**
 * `lp_book::RequestPage`. The two leading `Option<u64>`s are the page's prev/next
 * links; we never follow them (listDynamicFields hands us every page, and entries
 * carry their own monotonically increasing `index`, which IS the FIFO order).
 */
const RequestPage = bcs.struct('RequestPage', {
  prev: bcs.option(bcs.u64()),
  next: bcs.option(bcs.u64()),
  entries: bcs.vector(RequestEntry),
});

/** One un-filled LP request sitting in the queue. */
export interface LpQueueEntry {
  /** Queue index — the argument `cancel_*_request` takes. */
  index: bigint;
  /** The requesting Account object's id (NOT the wallet address). */
  accountId: string;
  /** Where the filled shares/DUSDC will be delivered (the account wrapper). */
  recipient: string;
  /**
   * Escrowed amount, base units @6dec. DUSDC for a supply; PLP shares for a
   * withdraw (the two are NOT the same unit — never sum them together).
   */
  amount: bigint;
}

export interface LpQueue {
  entries: LpQueueEntry[];
  /** Total escrowed in this queue (base units) — the vault's own tally. */
  escrow: bigint;
  /** The vault's own pending count, used to prove we read every page. */
  pending: bigint;
}

export interface LpQueues {
  supply: LpQueue;
  withdraw: LpQueue;
}

/** The subset of the Sui client this module needs (mirrors SimulateCapableClient). */
export interface QueueCapableClient {
  getObjects: (opts: { objectIds: string[]; include: { json: true } }) => Promise<{
    objects: { json?: unknown }[];
  }>;
  listDynamicFields: (opts: { parentId: string; include: { value: true } }) => Promise<{
    dynamicFields: { value?: { bcs: Uint8Array } }[];
  }>;
}

/** The queue as the PoolVault's json exposes it (gRPC shape). */
interface RawQueue {
  escrow?: string;
  pending?: string;
  pages?: { id?: string };
}

async function readQueue(client: QueueCapableClient, raw: RawQueue | undefined, label: string): Promise<LpQueue> {
  const pagesId = raw?.pages?.id;
  if (!pagesId) throw new Error(`readLpQueues: no ${label} pages table on the PoolVault`);
  const escrow = BigInt(raw?.escrow ?? 0);
  const pending = BigInt(raw?.pending ?? 0);

  const { dynamicFields } = await client.listDynamicFields({ parentId: pagesId, include: { value: true } });
  const entries: LpQueueEntry[] = [];
  for (const f of dynamicFields) {
    if (!f.value?.bcs) continue;
    const page = RequestPage.parse(new Uint8Array(f.value.bcs));
    for (const e of page.entries) {
      entries.push({
        index: BigInt(e.index),
        accountId: e.account_id,
        recipient: e.recipient,
        amount: BigInt(e.amount),
      });
    }
  }
  // FIFO: the keeper fills in ascending index, so that's the order to show.
  entries.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));

  // Self-check against the vault's own tallies. If these disagree we mis-parsed a
  // page or missed one — better to surface that than to render a queue that quietly
  // omits someone's money (or invites a cancel against a stale index).
  const sum = entries.reduce((s, e) => s + e.amount, 0n);
  if (BigInt(entries.length) !== pending || sum !== escrow) {
    throw new Error(
      `readLpQueues: ${label} queue failed reconciliation — parsed ${entries.length} entries / ${sum} base units, ` +
        `vault reports ${pending} pending / ${escrow} escrowed`,
    );
  }
  return { entries, escrow, pending };
}

/** Read both LP queues (supply + withdraw) straight from the PoolVault. */
export async function readLpQueues(client: QueueCapableClient): Promise<LpQueues> {
  const res = await client.getObjects({
    objectIds: [predictV2Config.shared.poolVault],
    include: { json: true },
  });
  const lp = (res.objects[0]?.json as { lp?: { supply_queue?: RawQueue; withdraw_queue?: RawQueue } } | undefined)?.lp;
  if (!lp) throw new Error('readLpQueues: PoolVault returned no lp state');

  const [supply, withdraw] = await Promise.all([
    readQueue(client, lp.supply_queue, 'supply'),
    readQueue(client, lp.withdraw_queue, 'withdraw'),
  ]);
  return { supply, withdraw };
}
