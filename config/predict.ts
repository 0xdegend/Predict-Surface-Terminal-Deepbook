/**
 * config/predict.ts — single source of truth for protocol IDs, keyed by network.
 *
 * Mainnet cutover = flip NEXT_PUBLIC_SUI_NETWORK (or change the default below).
 * Nothing else in the app should hardcode a package/object/asset ID. If you find
 * an inline `0x...` outside this file, it's a bug.
 *
 * Testnet values are pinned to deepbookv3 branch `predict-testnet-4-16`
 * (MystenLabs/deepbookv3, packages/predict). They WILL change at mainnet.
 */

export type SuiNetwork = 'testnet' | 'mainnet';

export interface PredictConfig {
  network: SuiNetwork;
  /** Fullnode gRPC endpoint (used by SuiGrpcClient for on-chain reads / devInspect). */
  grpcUrl: string;
  /** Public Predict indexer/server base URL (lists, portfolio, vault, history). */
  serverUrl: string;
  /** deepbook_predict package ID. */
  packageId: string;
  /** Predict registry object. */
  registryId: string;
  /** Predict shared object (passed as `predict` to every entry function). */
  predictObjectId: string;
  /** Sui system Clock object — always 0x6, but kept here so callers never inline it. */
  clockId: string;
  quote: {
    /** Fully-qualified Coin type for the quote asset (DUSDC). */
    coinType: string;
    /** Currency / metadata object ID. */
    currencyId: string;
    decimals: number;
    symbol: string;
  };
  /** PLP (LP share) coin type returned by `supply`. */
  plpCoinType: string;
  /**
   * Our own `predict_hedge` router package (the atomic "PLP + hedge" composer).
   * Empty string = not deployed for this network yet → the Hedge Vault UI shows a
   * "not deployed" state instead of building a doomed tx. See contracts/predict_hedge.
   */
  hedgePackageId: string;
  /**
   * Our `skew_fee` builder-fee router package + its shared `FeeConfig` object.
   * BOTH empty = not deployed for this network → the app falls back to the plain
   * `predict::mint` flow with NO fee, so the UI never breaks pre-deploy. Fill both
   * after `sui client publish` (see contracts/skew_fee/README.md). The live fee %
   * is read on-chain from `FeeConfig.fee_bps`, not hardcoded here.
   */
  skewFeePackageId: string;
  feeConfigId: string;
  /** Optional: testnet DUSDC faucet request form (not the standard USDC faucet). */
  faucetUrl?: string;
}

const TESTNET: PredictConfig = {
  network: 'testnet',
  grpcUrl: 'https://fullnode.testnet.sui.io:443',
  serverUrl: 'https://predict-server.testnet.mystenlabs.com',
  packageId: '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138',
  registryId: '0x43af14fed5480c20ff77e2263d5f794c35b9fab7e2212903127062f4fe2a6e64',
  predictObjectId: '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a',
  clockId: '0x6',
  quote: {
    coinType: '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC',
    currencyId: '0xf3000dff421833d4bb8ed58fac146d691a3aaba2785aa1989af65a7089ca3e9c',
    decimals: 6,
    symbol: 'DUSDC',
  },
  plpCoinType: '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138::plp::PLP',
  hedgePackageId: '0x188db05516fb336aae9efca852e23b2d593430332da5e56266deb84aecdfb787',
  // skew_fee router — published on testnet 2026-06-14 (AdminCap + UpgradeCap held
  // by the deployer 0x33a8c3…). FeeConfig defaults: 100 bps (1%), treasury = deployer.
  skewFeePackageId: '0x3dcc142dd54a471e2c894f7180e59740f473da1024c966a5ea6b1c3be1dbe9f4',
  feeConfigId: '0xd9b00d5d7060b30fe312f9367336e5289ab4ddcca48c9e6ace8f04bf066e40fd',
  faucetUrl: 'https://tally.so/r/Xx102L',
};

// Mainnet placeholders — fill in on redeploy. Day-one mainnet swap is a config edit only.
const MAINNET: PredictConfig = {
  network: 'mainnet',
  grpcUrl: 'https://fullnode.mainnet.sui.io:443',
  serverUrl: '', // TODO: mainnet Predict server URL
  packageId: '', // TODO
  registryId: '', // TODO
  predictObjectId: '', // TODO
  clockId: '0x6',
  quote: {
    coinType: '', // TODO: mainnet quote asset (likely native USDC)
    currencyId: '',
    decimals: 6,
    symbol: 'USDC',
  },
  plpCoinType: '', // TODO
  hedgePackageId: '', // TODO: publish predict_hedge on mainnet, then fill
  skewFeePackageId: '', // TODO: publish skew_fee on mainnet, then fill
  feeConfigId: '', // TODO
};

const CONFIGS: Record<SuiNetwork, PredictConfig> = {
  testnet: TESTNET,
  mainnet: MAINNET,
};

/** Active network. Defaults to testnet; override with NEXT_PUBLIC_SUI_NETWORK. */
export const ACTIVE_NETWORK: SuiNetwork =
  (process.env.NEXT_PUBLIC_SUI_NETWORK as SuiNetwork) || 'testnet';

export const predictConfig: PredictConfig = CONFIGS[ACTIVE_NETWORK];

/** True when the skew_fee builder-fee router is deployed for the active network
 *  (both the package and its FeeConfig object id are set). When false, mints use
 *  the plain `predict::mint` flow with no fee. */
export const feeRouterEnabled: boolean =
  !!predictConfig.skewFeePackageId && !!predictConfig.feeConfigId;

export function getPredictConfig(network: SuiNetwork = ACTIVE_NETWORK): PredictConfig {
  return CONFIGS[network];
}

/** Fully-qualified type helpers (e.g. for event filters / moveCall type args). */
export const moveTarget = (module: string, fn: string): `${string}::${string}::${string}` =>
  `${predictConfig.packageId}::${module}::${fn}` as const;

export const eventType = (module: string, name: string): string =>
  `${predictConfig.packageId}::${module}::${name}`;

/* ===================================================================== *
 *  V2 DEPLOYMENT  (branch predict-testnet-6-24)
 * ---------------------------------------------------------------------
 *  A ground-up redesign, NOT a redeploy. Different custody (account pkg:
 *  AccountWrapper + Auth), oracle (propbook + 4 block-scholes feeds), per-
 *  expiry ExpiryMarket objects, native leverage/liquidation, async PLP, and
 *  a new beta server. The LEGACY config above stays the source of truth for
 *  the current (frozen) app; this block powers the new "Latest" deployment.
 *
 *  IDs are read verbatim from packages/predict/deployment/deployment.testnet.json
 *  on branch predict-testnet-6-24 (dated 2026-06-25). Always re-check that JSON
 *  on any redeploy — it's the upstream source of truth.
 * ===================================================================== */

export type Deployment = 'legacy' | 'v2';

/**
 * Flip to `true` once the v2 data + trade layers (migration Phases 1–2) are
 * live. While `false`, the user-facing toggle shows "Latest" as a teaser but
 * keeps it disabled, so switching can never drop users into a half-built path.
 */
export const V2_READY = false;

export interface PredictV2Config {
  network: SuiNetwork;
  deployment: 'v2';
  grpcUrl: string;
  /** New beta indexer: /markets, /managers, /manager-orders, /supply-requests, … */
  serverUrl: string;
  /** Optional propbook oracle indexer (Pyth/Block-Scholes observation history). */
  oracleServerUrl: string;
  packages: {
    predict: string;
    account: string;
    propbook: string;
    blockScholesOracle: string;
    fixedMath: string;
  };
  /** Shared objects passed into entry functions. */
  shared: {
    protocolConfig: string; // predict::protocol_config::ProtocolConfig
    poolVault: string; // predict::plp::PoolVault
    registry: string; // predict::registry::Registry
    oracleRegistry: string; // propbook::registry::OracleRegistry
    accountRegistry: string; // account::account_registry::AccountRegistry
  };
  /** Per-owner balances/accounting live behind a shared AccumulatorRoot. */
  accumulatorRootId: string;
  clockId: string;
  quote: { coinType: string; currencyId: string; decimals: number; symbol: string };
  plpCoinType: string;
  /** DEEP staking is part of the new vault; coin type for stake/unstake flows. */
  deepPackageId: string;
  /** The tradeable underlying + its four oracle feed objects (for load_live_pricer). */
  asset: {
    name: string;
    propbookUnderlyingId: number;
    pythFeedId: string;
    bsSpotFeedId: string;
    bsForwardFeedId: string;
    bsSviFeedId: string;
  };
  /** Rolling market cadences (markets are created on schedule; discover via /markets). */
  cadences: {
    id: number;
    name: string;
    tickSize: string;
    admissionTickSize: string;
    maxExpiryAllocation: string;
    initialExpiryCash: string;
    windowSize: string;
  }[];
  faucetUrl?: string;
}

const V2_TESTNET: PredictV2Config = {
  network: 'testnet',
  deployment: 'v2',
  grpcUrl: 'https://fullnode.testnet.sui.io:443',
  serverUrl: 'https://predict-server-beta.testnet.mystenlabs.com',
  oracleServerUrl: 'https://propbook.api.testnet.mystenlabs.com',
  packages: {
    predict: '0xdb3ef5a5129920e59c9b2ae25a77eddb48acd0e1c6307b97073f0e076016446e',
    account: '0xb9389eac8d59170ffd1427c1a66e5c8306263464fcc6615e825c1f5b3e15da3b',
    propbook: '0x8eb2adde1c91f8b7c9ba5e9b0a32bfb804510c342939c5f77458fd8143f9755b',
    blockScholesOracle: '0x8192932b70d5946217d0f09aad44f84ad5c27ee4c1ca31b09f46200fbd31d3de',
    fixedMath: '0x6930d8eff504f15e45e7ceec3d504bfc1a6f1e1d4c02babe03c156f77b84523d',
  },
  shared: {
    protocolConfig: '0x2325224629b4bd96d1f1d7ee937e07f8a06f861018a130bbb26db09cb0394cb6',
    poolVault: '0xfde98c636eb8a7aba59c3a238cfee6b576b7118d1e5ffa2952876c4b270a3a2a',
    registry: '0x54afbf245caf42466cedb5756ed7816f34f544afdfa13579a862eccf3afa21ca',
    oracleRegistry: '0xf3deaff68cbd081a35ec21653af6f671d2ad5f012f3b4d817d81752843374136',
    accountRegistry: '0x3c54d5b8b6bca376fc289121838ad02f8a5b3843242b9ad7e8f8245720e685a2',
  },
  accumulatorRootId: '0x0000000000000000000000000000000000000000000000000000000000000acc',
  clockId: '0x6',
  quote: {
    coinType: '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC',
    currencyId: '0xf3000dff421833d4bb8ed58fac146d691a3aaba2785aa1989af65a7089ca3e9c',
    decimals: 6,
    symbol: 'DUSDC',
  },
  plpCoinType: '0xdb3ef5a5129920e59c9b2ae25a77eddb48acd0e1c6307b97073f0e076016446e::plp::PLP',
  deepPackageId: '0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8',
  asset: {
    name: 'BTC_USD',
    propbookUnderlyingId: 1,
    pythFeedId: '0xc78d7de16217d46d21b92ae475da799448be30b71a758dc6d7bb3ac2f1c35afb',
    bsSpotFeedId: '0xcdc5fa7364e60fd2504aa96f65b707dc0734e507a919b1a7d7d63164fd67b745',
    bsForwardFeedId: '0xe72c734ea8d8dcbc9183d9d8f96f51aaa1fb5034d5ed33ac60d67d261e15b48a',
    bsSviFeedId: '0xdc2f8270676bd05fb28491e8d4a41a495722fda7a454926dd66dbba256a21c69',
  },
  cadences: [
    { id: 0, name: '1m', tickSize: '10000000', admissionTickSize: '1000000000', maxExpiryAllocation: '50000000000', initialExpiryCash: '10000000000', windowSize: '3' },
    { id: 1, name: '5m', tickSize: '10000000', admissionTickSize: '1000000000', maxExpiryAllocation: '50000000000', initialExpiryCash: '10000000000', windowSize: '3' },
    { id: 2, name: '1h', tickSize: '10000000', admissionTickSize: '1000000000', maxExpiryAllocation: '250000000000', initialExpiryCash: '50000000000', windowSize: '3' },
  ],
  faucetUrl: 'https://tally.so/r/Xx102L',
};

// Mainnet v2 placeholders — fill on the eventual mainnet redeploy.
const V2_MAINNET: PredictV2Config = {
  ...V2_TESTNET,
  network: 'mainnet',
  grpcUrl: 'https://fullnode.mainnet.sui.io:443',
  serverUrl: '',
  oracleServerUrl: '',
};

const V2_CONFIGS: Record<SuiNetwork, PredictV2Config> = {
  testnet: V2_TESTNET,
  mainnet: V2_MAINNET,
};

export const predictV2Config: PredictV2Config = V2_CONFIGS[ACTIVE_NETWORK];

export function getPredictV2Config(network: SuiNetwork = ACTIVE_NETWORK): PredictV2Config {
  return V2_CONFIGS[network];
}

/** True when the active-network v2 deployment has a server wired (testnet does). */
export const v2Deployed: boolean = !!predictV2Config.serverUrl;

/** Fully-qualified type helpers for the v2 predict package. */
export const v2Target = (
  module: string,
  fn: string,
): `${string}::${string}::${string}` =>
  `${predictV2Config.packages.predict}::${module}::${fn}` as const;

export const v2EventType = (module: string, name: string): string =>
  `${predictV2Config.packages.predict}::${module}::${name}`;
