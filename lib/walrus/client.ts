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

/** Warn once the writer is down to roughly this many more writes. */
const LOW_WATER_WRITES = 20n;

export interface WriterHealth {
  /** False when a write would fail right now (or the key is not configured at all). */
  ok: boolean;
  /** True when writes still work but the wallet is nearly dry. */
  low: boolean;
  /** SUI balance in MIST, or null when it could not be read. */
  suiMist: bigint | null;
  /** Roughly how many more receipts this wallet can pay for. */
  writesLeft: number | null;
  address: string | null;
  reason: 'ok' | 'low_gas' | 'no_gas' | 'unconfigured' | 'unreadable';
}

/**
 * Can the Walrus writer still pay for a write?
 *
 * This exists because the failure it detects is INVISIBLE. Receipt writes are
 * fire-and-forget by design (recording a call must never slow a reply or block a trade), so
 * when the writer wallet ran out of SUI on 2026-09-04 the POST simply 500'd into a
 * swallowed catch. Autopilot went on trading, every trade went unrecorded, and the track
 * record just quietly stopped growing for three days with nothing anywhere saying why.
 * WAL was never the problem and still is not: it is plain gas.
 *
 * Read-only and cheap. Callers surface it; nothing here throws.
 */
export async function writerHealth(): Promise<WriterHealth> {
  const address = process.env.WALRUS_WRITER_ADDRESS ?? null;
  if (!process.env.WALRUS_WRITER_KEY) {
    return { ok: false, low: false, suiMist: null, writesLeft: null, address, reason: 'unconfigured' };
  }
  let owner = address;
  if (!owner) {
    try {
      owner = getWriterKeypair().toSuiAddress();
    } catch {
      return { ok: false, low: false, suiMist: null, writesLeft: null, address: null, reason: 'unconfigured' };
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
    const sui = nodes.find((n) => n.coinType?.repr?.endsWith('::sui::SUI'));
    if (!sui?.totalBalance) {
      // No SUI row at all means a wallet with no SUI, which is a real answer, not a failure.
      return { ok: false, low: true, suiMist: 0n, writesLeft: 0, address: owner, reason: 'no_gas' };
    }
    const mist = BigInt(sui.totalBalance);
    const left = mist / WRITE_GAS_MIST;
    if (left < 1n) return { ok: false, low: true, suiMist: mist, writesLeft: 0, address: owner, reason: 'no_gas' };
    return {
      ok: true,
      low: left < LOW_WATER_WRITES,
      suiMist: mist,
      writesLeft: Number(left),
      address: owner,
      reason: left < LOW_WATER_WRITES ? 'low_gas' : 'ok',
    };
  } catch {
    // Could not check. Deliberately NOT reported as broken: claiming recording is down when
    // we merely failed to look is the same class of mistake as the silence this replaces.
    return { ok: true, low: false, suiMist: null, writesLeft: null, address: owner, reason: 'unreadable' };
  }
}
