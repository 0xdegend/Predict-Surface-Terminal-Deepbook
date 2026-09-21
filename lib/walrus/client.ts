/**
 * lib/walrus/client.ts — thin wrapper over @mysten/walrus (Walrus blob storage on Sui).
 *
 * Phase 0 (2026-08-15), proven end-to-end on testnet:
 *   - WRITES go through the upload relay, then the SDK registers/certifies the blob
 *     on-chain (gRPC) signed by a dedicated writer key (`WALRUS_WRITER_KEY`). The relay
 *     distributes slivers so we don't talk to every storage node directly (that fails
 *     from constrained/serverless environments, and browsers can't do it at all). Writes
 *     are therefore SERVER-ONLY here (they read a private key from the environment).
 *   - READS go through the public HTTP aggregator: fast, CDN-fronted, no wallet, and safe
 *     from both the browser and the server. This avoids the SDK's direct storage-node
 *     read path, which is blocked in the same environments as direct writes.
 *
 * This is the seam every later Walrus feature plugs into (Kelly receipts, durable market
 * history, MemWal-backed memory). See config/walrus.ts and the [[walrus-for-kelly]] plan.
 *
 * Later phases: browser/gasless writes will reuse the same relay host with the Enoki
 * sponsor instead of the env key. The read helpers below already work unchanged in the
 * browser.
 */

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Signer } from '@mysten/sui/cryptography';
import { walrus } from '@mysten/walrus';
import { walrusConfig } from '@/config/walrus';
import { predictV2Config } from '@/config/predict';

/* --------------------------------- reads --------------------------------- */

/** Read a blob's raw bytes via the HTTP aggregator (browser- and server-safe, no wallet). */
export async function readBlob(blobId: string): Promise<Uint8Array> {
  const url = `${walrusConfig.aggregatorUrl}/v1/blobs/${encodeURIComponent(blobId)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Walrus read failed for ${blobId}: ${res.status} ${res.statusText}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Read a blob and decode it as UTF-8 text. */
export async function readBlobText(blobId: string): Promise<string> {
  return new TextDecoder().decode(await readBlob(blobId));
}

/** Read a blob and parse it as JSON. */
export async function readBlobJson<T = unknown>(blobId: string): Promise<T> {
  return JSON.parse(await readBlobText(blobId)) as T;
}

/* --------------------------------- writes -------------------------------- */

/**
 * Build the write client for the active network: a gRPC Sui client (public JSON-RPC is
 * deprecated on testnet fullnodes) extended with Walrus and configured to upload through
 * the relay. The walrus extension reads its network from `client.network`.
 */
function makeWriteClient() {
  const baseUrl = process.env.NEXT_PUBLIC_SUI_GRPC_URL || predictV2Config.grpcUrl;
  return new SuiGrpcClient({ network: walrusConfig.network, baseUrl }).$extend(
    walrus({
      uploadRelay: {
        host: walrusConfig.uploadRelayUrl,
        sendTip: { max: walrusConfig.uploadRelayMaxTipMist },
      },
    }),
  );
}

let _write: ReturnType<typeof makeWriteClient> | null = null;

/** Cached Walrus write client. Server-side only (writes register a blob on-chain). */
export function getWalrusWriteClient() {
  return (_write ??= makeWriteClient());
}

/**
 * The server-side writer keypair, derived from `WALRUS_WRITER_KEY` (a bech32
 * `suiprivkey1…`). Throws if unset so a missing key fails loudly rather than silently
 * attempting an unsigned write. Never import this into client-side code.
 */
export function getWriterKeypair(): Ed25519Keypair {
  const secret = process.env.WALRUS_WRITER_KEY;
  if (!secret) {
    throw new Error(
      'WALRUS_WRITER_KEY is not set. It is required for server-side Walrus writes (see config/walrus.ts).',
    );
  }
  return Ed25519Keypair.fromSecretKey(secret);
}

export interface StoreBlobOptions {
  /** Storage duration in epochs. Defaults to `walrusConfig.defaultEpochs`. */
  epochs?: number;
  /** Deletable blobs can be removed by the owner (default true). Set false for permanence. */
  deletable?: boolean;
  /** Override the signer (defaults to the env writer key). */
  signer?: Signer;
}

export interface StoreBlobResult {
  /** Content-addressed blob id (URL-safe base64) — use this to read the blob back. */
  blobId: string;
  /** Sui object id of the on-chain Blob object (use for extend/delete/share). */
  objectId: string;
  /** Epoch this blob's storage expires at. */
  endEpoch: number;
}

/**
 * Store bytes (or a UTF-8 string) as a Walrus blob. Server-side, signed by the writer key,
 * uploaded through the relay. Returns the content-addressed blob id.
 */
export async function storeBlob(
  data: Uint8Array | string,
  opts: StoreBlobOptions = {},
): Promise<StoreBlobResult> {
  const blob = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const { blobId, blobObject } = await getWalrusWriteClient().walrus.writeBlob({
    blob,
    epochs: opts.epochs ?? walrusConfig.defaultEpochs,
    deletable: opts.deletable ?? true,
    signer: opts.signer ?? getWriterKeypair(),
  });
  return {
    blobId,
    objectId: blobObject.id,
    endEpoch: blobObject.storage.end_epoch,
  };
}

/** Store a JSON-serializable value as a UTF-8 JSON blob. */
export function storeJson(value: unknown, opts?: StoreBlobOptions): Promise<StoreBlobResult> {
  return storeBlob(JSON.stringify(value), opts);
}

/* ------------------------------ writer health ----------------------------- */

/**
 * What one blob write costs in gas, in MIST, as a floor.
 *
 * Measured from the abort the writer actually produced when it ran dry:
 * "insufficient SUI balance … to satisfy required budget 6611600". Rounded up, because the
 * budget moves with the transaction and this is used to warn BEFORE the last write fails,
 * not to price one exactly.
 */
const WRITE_GAS_MIST = 7_000_000n;

/**
 * What one blob write costs in STORAGE, in FROST (WAL has 9 decimals), as a floor.
 *
 * Measured the same way, from the abort the writer produced on 2026-09-21: "Insufficient
 * balance of …::wal::WAL … Required: 1344546, Available: 879287". Rounded up.
 *
 * This tracks `walrusConfig.defaultEpochs`: storage is bought by the epoch, so keeping a
 * blob for longer costs proportionally more. Raise the epochs and raise this with them.
 */
const WRITE_WAL_FROST = 1_500_000n;

/** Warn once the writer is down to roughly this many more writes. */
const LOW_WATER_WRITES = 20n;

export interface WriterHealth {
  /** False when a write would fail right now (or the key is not configured at all). */
  ok: boolean;
  /** True when writes still work but the wallet is nearly dry. */
  low: boolean;
  /** SUI balance in MIST, or null when it could not be read. */
  suiMist: bigint | null;
  /** WAL balance in FROST, or null when it could not be read. */
  walFrost: bigint | null;
  /**
   * Roughly how many more receipts this wallet can pay for: the SMALLER of what its gas
   * and its storage can cover, because a write needs both and runs out at the first one.
   */
  writesLeft: number | null;
  address: string | null;
  reason: 'ok' | 'low_gas' | 'no_gas' | 'low_wal' | 'no_wal' | 'unconfigured' | 'unreadable';
}

/**
 * Can the Walrus writer still pay for a write?
 *
 * This exists because the failure it detects is INVISIBLE. Receipt writes are
 * fire-and-forget by design (recording a call must never slow a reply or block a trade), so
 * when the writer wallet ran out of SUI on 2026-09-04 the POST simply 500'd into a
 * swallowed catch. Autopilot went on trading, every trade went unrecorded, and the track
 * record just quietly stopped growing for three days with nothing anywhere saying why.
 *
 * A write costs TWO things, and this checks both. It used to check only gas, on the stated
 * belief that "WAL was never the problem". On 2026-09-21 it was: the wallet held 1.06 SUI
 * and 0.00088 WAL against the 0.00134 a write needs, so every POST failed while this
 * function cheerfully reported 152 writes left and the live test that asserts on it passed.
 * A health check that reads one of two required resources is not a weaker check, it is a
 * confident wrong answer, which is worse than the silence it was written to replace.
 *
 * Read-only and cheap. Callers surface it; nothing here throws.
 */
export async function writerHealth(): Promise<WriterHealth> {
  const address = process.env.WALRUS_WRITER_ADDRESS ?? null;
  if (!process.env.WALRUS_WRITER_KEY) {
    return { ok: false, low: false, suiMist: null, walFrost: null, writesLeft: null, address, reason: 'unconfigured' };
  }
  let owner = address;
  if (!owner) {
    try {
      owner = getWriterKeypair().toSuiAddress();
    } catch {
      return { ok: false, low: false, suiMist: null, walFrost: null, writesLeft: null, address: null, reason: 'unconfigured' };
    }
  }
  try {
    const res = await fetch(`https://graphql.${walrusConfig.network}.sui.io/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{ address(address:"${owner}"){ balances(first:20){ nodes { coinType{repr} totalBalance } } } }`,
      }),
      cache: 'no-store',
    });
    const json = (await res.json()) as {
      data?: { address?: { balances?: { nodes?: { coinType?: { repr?: string }; totalBalance?: string }[] } } };
    };
    const nodes = json.data?.address?.balances?.nodes ?? [];
    // Matched on the type SUFFIX, not a full address, so this reads the right WAL on both
    // networks without a second table of ids to drift out of date.
    // A missing row means a wallet holding none of that coin, which is a real answer rather
    // than a failure to look, so it counts as zero.
    //
    // `totalBalance` here is coin objects PLUS the address balance (Sui's accumulator), and
    // that total is the number we want. Do not "correct" this to the coin-object balance:
    // on 2026-09-21 the writer held 1.0639 SUI in its address balance and 0.0015 in coins,
    // and transactions signed by it paid a 20,000,000 MIST gas budget perfectly happily, so
    // the total was what it could actually spend. The SDK draws on both for ordinary coin
    // arguments too. Two local tools disagree and neither is authoritative here: `sui client
    // balance` and `sui client gas` list only coin OBJECTS (they showed 0.00 SUI against a
    // healthy wallet), and the `walrus` CLI's own coin selection cannot see address balances
    // at all, which is why `walrus get-wal` fails with "could not find SUI coins with
    // sufficient balance" on a wallet that is fine.
    const balanceOf = (suffix: string): bigint => {
      const row = nodes.find((n) => n.coinType?.repr?.endsWith(suffix));
      try {
        return row?.totalBalance ? BigInt(row.totalBalance) : 0n;
      } catch {
        return 0n;
      }
    };
    const mist = balanceOf('::sui::SUI');
    const frost = balanceOf('::wal::WAL');

    // A write spends gas AND storage, so it runs out at whichever comes first. Reporting
    // the gas figure alone is how a wallet with a full tank and no WAL passed as healthy.
    const gasWrites = mist / WRITE_GAS_MIST;
    const walWrites = frost / WRITE_WAL_FROST;
    const left = gasWrites < walWrites ? gasWrites : walWrites;
    /** Which of the two is the binding constraint, and therefore the one to top up. */
    const short: 'gas' | 'wal' = gasWrites <= walWrites ? 'gas' : 'wal';

    if (left < 1n) {
      return {
        ok: false,
        low: true,
        suiMist: mist,
        walFrost: frost,
        writesLeft: 0,
        address: owner,
        reason: short === 'gas' ? 'no_gas' : 'no_wal',
      };
    }
    return {
      ok: true,
      low: left < LOW_WATER_WRITES,
      suiMist: mist,
      walFrost: frost,
      writesLeft: Number(left),
      address: owner,
      reason: left < LOW_WATER_WRITES ? (short === 'gas' ? 'low_gas' : 'low_wal') : 'ok',
    };
  } catch {
    // Could not check. Deliberately NOT reported as broken: claiming recording is down when
    // we merely failed to look is the same class of mistake as the silence this replaces.
    return { ok: true, low: false, suiMist: null, walFrost: null, writesLeft: null, address: owner, reason: 'unreadable' };
  }
}
