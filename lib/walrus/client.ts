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
      'WALRUS_WRITER_KEY is not set — required for server-side Walrus writes (see config/walrus.ts).',
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
