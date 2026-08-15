/**
 * config/walrus.ts — Walrus (decentralized blob storage on Sui) endpoints, keyed by
 * network. Mirrors config/predict.ts: nothing else in the app should hardcode a Walrus
 * URL. If you find an inline walrus.space URL outside this file, it's a bug.
 *
 * The @mysten/walrus SDK bundles the Walrus system/staking object IDs per network, so we
 * only keep the HTTP endpoints + our defaults here (no object IDs to drift).
 *
 * Phase 0 (2026-08-15): this backs a SERVER-SIDE store/read path signed by a dedicated
 * writer key. Browser/gasless writes (upload relay + the existing Enoki sponsor) come
 * in a later phase and will reuse `uploadRelayUrl` below. See lib/walrus/client.ts and
 * the [[walrus-for-kelly]] plan.
 */

import { ACTIVE_NETWORK, type SuiNetwork } from './predict';

export interface WalrusConfig {
  network: SuiNetwork;
  /** Public aggregator base URL — blob READS (GET /v1/blobs/:blobId). Free, no wallet. */
  aggregatorUrl: string;
  /**
   * Public publisher base URL — HTTP writes without holding WAL yourself.
   * TESTNET ONLY: there is no public mainnet publisher (run your own or use the SDK
   * directly with a funded writer). Empty string = none for this network.
   */
  publisherUrl: string;
  /**
   * Upload relay for BROWSER SDK writes. Browsers cannot distribute slivers to storage
   * nodes directly, so in-browser writes route through this. Server-side writes talk to
   * storage nodes directly and do NOT need it.
   */
  uploadRelayUrl: string;
  /** Default storage duration (epochs) for app-written blobs. 1 testnet epoch ~= 1 day. */
  defaultEpochs: number;
  /** Max tip (MIST) we allow the upload relay to charge on a browser write. */
  uploadRelayMaxTipMist: number;
  /**
   * Walrus Memory (MemWal) managed relayer for Kelly's agent memory. Testnet uses the
   * staging relayer; a mainnet account will NOT work against staging and vice versa.
   * The relayer handles embeddings, Seal encryption, Walrus upload, and vector search,
   * so the SDK client just needs the delegate key + accountId. See lib/walrus/memory.ts.
   */
  memoryRelayerUrl: string;
}

const TESTNET: WalrusConfig = {
  network: 'testnet',
  aggregatorUrl: 'https://aggregator.walrus-testnet.walrus.space',
  publisherUrl: 'https://publisher.walrus-testnet.walrus.space',
  uploadRelayUrl: 'https://upload-relay.testnet.walrus.space',
  defaultEpochs: 5,
  uploadRelayMaxTipMist: 1_000_000,
  memoryRelayerUrl: 'https://relayer-staging.memory.walrus.xyz', // testnet = staging relayer
};

const MAINNET: WalrusConfig = {
  network: 'mainnet',
  aggregatorUrl: 'https://aggregator.walrus-mainnet.walrus.space',
  publisherUrl: '', // no public mainnet publisher — run our own or use the SDK directly
  uploadRelayUrl: 'https://upload-relay.mainnet.walrus.space',
  defaultEpochs: 5,
  uploadRelayMaxTipMist: 1_000_000,
  memoryRelayerUrl: 'https://relayer.memory.walrus.xyz', // mainnet = production relayer
};

const CONFIGS: Record<SuiNetwork, WalrusConfig> = {
  testnet: TESTNET,
  mainnet: MAINNET,
};

/** Active-network Walrus config. Follows the same NEXT_PUBLIC_SUI_NETWORK switch as Predict. */
export const walrusConfig: WalrusConfig = CONFIGS[ACTIVE_NETWORK];

export function getWalrusConfig(network: SuiNetwork = ACTIVE_NETWORK): WalrusConfig {
  return CONFIGS[network];
}
