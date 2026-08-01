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
 * Whether the v2 (Latest) release is user-selectable. Now `true`: the v2 data +
 * trade layers are live, so the toggle enables "Latest" (tagged Beta) and root
 * (/) lands there. While it was `false`, "Latest" showed as a disabled "Soon"
 * teaser so switching could never drop users into a half-built path.
 */
export const V2_READY = true;

/**
 * Which testnet Predict deployment the "Latest" experience reads/writes against.
 *
 * This is an INVISIBLE backbone switch — same routes, same components, same copy,
 * same UI. It only repoints contract IDs + the data source. Default '6-24' (the
 * current live deployment); set NEXT_PUBLIC_PREDICT_DEPLOYMENT=7-29 to target the
 * new one. Mainnet is unaffected. A cutover / rollback is this one env var. See the
 * predict-migration-7-29 notes for the full plan.
 */
export type PredictDeployment = '6-24' | '7-29';
export const ACTIVE_V2_DEPLOYMENT: PredictDeployment =
  process.env.NEXT_PUBLIC_PREDICT_DEPLOYMENT === '7-29' ? '7-29' : '6-24';

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
  /**
   * Our registered `builder_code::BuilderCode` (shared). Empty = not registered
   * for this network → no attach, no fee, UI hidden. The protocol pays an add-on
   * builder fee (10% of the trade fee, capped at 0.5% of notional) to whatever
   * code the TRADER'S ACCOUNT carries — so we must attach it to each account.
   * Its `owner` is fixed at creation and can never change; only that address can
   * claim. See lib/sui/v2/builder-code.ts.
   */
  builderCodeId: string;
  /**
   * Window (ms before expiry) during which the protocol admits NO leverage above
   * 1x for normal-probability bets — `strike_exposure_config::no_leverage_window_ms`,
   * verified live on 7-29 = 3_600_000 (60 min). Every short testnet market sits
   * inside it, so leverage is 1x there; it only opens up on markets further from
   * expiry. 0 = no such window (6-24 used a probability-only admission curve).
   * See lib/sui/v2/quote.ts.
   */
  noLeverageWindowMs: number;
  /** Per-owner balances/accounting live behind a shared AccumulatorRoot. */
  accumulatorRootId: string;
  clockId: string;
  quote: { coinType: string; currencyId: string; decimals: number; symbol: string };
  plpCoinType: string;
  /** DEEP staking is part of the new vault; coin type for stake/unstake flows. */
  deepPackageId: string;
  /** The tradeable underlying + its oracle feed objects (for load_live_pricer). */
  asset: {
    name: string;
    propbookUnderlyingId: number;
    /** Pyth spot feed object id. Read by the pricer AND directly by the spot /
     *  chart / portfolio hooks, so it stays a named field. */
    pythFeedId: string;
    /**
     * Block-Scholes oracle feed object ids passed to `load_live_pricer`, in call
     * order, AFTER the pyth feed. Length is deployment-specific: 6-24 has three
     * (spot, forward, svi); 7-29 has two (value store, svi store). See pricer.ts.
     */
    bsFeedIds: string[];
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
  /**
   * Wallets always shown on the v2 leaderboard, regardless of who is connected.
   * The board is rebuilt from a ~500-market / ~8h retained order window, so a
   * wallet whose trades have aged out of that window only reappears when IT is
   * connected (its full account history gets folded in). Listing an address here
   * folds its complete history in for everyone — the same completeness the
   * connected wallet gets — so known/demo traders never silently drop off.
   * See lib/hooks/use-v2-leaderboard.ts.
   */
  featuredWallets: string[];
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
  // Registered 2026-07-13 (index 0). owner = 0x33a8c3…f3f4 (the deployer key) —
  // PERMANENT, no setter exists on-chain. Mainnet must register from a multisig.
  // Override with NEXT_PUBLIC_BUILDER_CODE_ID to point the app at a code owned by
  // a different wallet (register it from that wallet at /v2/admin first) without
  // editing this file.
  builderCodeId:
    process.env.NEXT_PUBLIC_BUILDER_CODE_ID ||
    '0x3d916a9be41e850028b342029301e4d7ec19a1c3a843b55ec256d789cfdf2194',
  noLeverageWindowMs: 0, // 6-24 used a probability-only admission curve (no window)
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
    // 6-24 pricer takes three block-scholes feeds: spot, forward, svi (this order).
    bsFeedIds: [
      '0xcdc5fa7364e60fd2504aa96f65b707dc0734e507a919b1a7d7d63164fd67b745',
      '0xe72c734ea8d8dcbc9183d9d8f96f51aaa1fb5034d5ed33ac60d67d261e15b48a',
      '0xdc2f8270676bd05fb28491e8d4a41a495722fda7a454926dd66dbba256a21c69',
    ],
  },
  cadences: [
    { id: 0, name: '1m', tickSize: '10000000', admissionTickSize: '1000000000', maxExpiryAllocation: '50000000000', initialExpiryCash: '10000000000', windowSize: '3' },
    { id: 1, name: '5m', tickSize: '10000000', admissionTickSize: '1000000000', maxExpiryAllocation: '50000000000', initialExpiryCash: '10000000000', windowSize: '3' },
    { id: 2, name: '1h', tickSize: '10000000', admissionTickSize: '1000000000', maxExpiryAllocation: '250000000000', initialExpiryCash: '50000000000', windowSize: '3' },
  ],
  // Always-on leaderboard entrants. Comma-separated NEXT_PUBLIC_FEATURED_WALLETS
  // overrides this list without editing the file. Both have traded on this
  // deployment but their trades age out of the retained window; pinning keeps
  // them on the board every time (verified accounts, live 2026-07-15).
  featuredWallets: process.env.NEXT_PUBLIC_FEATURED_WALLETS
    ? process.env.NEXT_PUBLIC_FEATURED_WALLETS.split(',').map((s) => s.trim()).filter(Boolean)
    : [
        '0x33a8c34ae6f4dd41288ddb81c521b3c2a49c251abcc0926fe54c6376757ff3f4',
        '0x22cc7ef79881b98152d9a7c2a50fefe42a468434ddff07e14b08562774a1940f',
      ],
  faucetUrl: 'https://tally.so/r/Xx102L',
};

/**
 * 7-29 deployment (branch predict-testnet-7-29, deployed 2026-07-30). Selected when
 * NEXT_PUBLIC_PREDICT_DEPLOYMENT=7-29. Every id verified on-chain + against
 * deployment.testnet.json (sourceCommit 4c3c62c) during Phase 0 (2026-08-01).
 *
 * ⚠️ Phase 1 = config only. There is NO 7-29 HTTP indexer, so serverUrl /
 * oracleServerUrl stay empty; Phase 3 wires on-chain gRPC reads behind the existing
 * lib/api/v2/client.ts seams. The pricer already handles the 3-feed shape via
 * asset.bsFeedIds (Phase-0 dry-run confirmed). Do NOT flip the default to 7-29 until
 * Phases 2-3 land and the Phase-5 checks pass.
 */
const V2_TESTNET_729: PredictV2Config = {
  network: 'testnet',
  deployment: 'v2',
  grpcUrl: 'https://fullnode.testnet.sui.io:443',
  serverUrl: '', // no 7-29 HTTP indexer — on-chain gRPC reads land in Phase 3
  oracleServerUrl: '', // ditto — pyth spot moves to on-chain reads in Phase 3
  packages: {
    predict: '0xd94387c857ab56857f5f2750f2ba959fb007306f977a24290342433aef090298',
    account: '0xdabedf28ee547a20cb4ed30d4ff3dab686ff2926add584822466efded14cec4a',
    propbook: '0x756ab217b8b7cbbe7a9e45a5cc385347cb43f74aac0102772336a24cf48ab9cb',
    // 7-29 folds block-scholes into propbook; this is the price-updater's oracle
    // package (writers.priceUpdater.blockScholesOraclePackage). No code reads it.
    blockScholesOracle: '0x87cc43db9b6c1e8b174841221e8e4bde5ab8fc8aaffacc58699c77e9e6340ff6',
    fixedMath: '0xd81b1e5a28d616b8ff9eeda2241866ece02767fc4f368bec23b8eb57334f3d2d',
  },
  shared: {
    protocolConfig: '0x19a07f5be96ca7b47e8b2ec39d7caf40e1fbb7d4156a699bfecda807d1d3d427',
    poolVault: '0x90454f005b8eca464317ffb31adf5e39da94a9304b11b9501d5668d0103bbb0a',
    registry: '0xafc24283eec35728da1184eea118c41067bbde153447f9946e0667672f18a383',
    oracleRegistry: '0xec1a1aa6aeffb45aae40cba097714e711acc28739faa005e1932de608189667f',
    accountRegistry: '0x316fa986a919b2f69884bfeec2a8668bf671a4d05c1c434ad6d9647a41d2ccb2',
  },
  // Registered 2026-08-01 (index 1) via /v2/admin. owner = 0x33a8c3…f3f4 (founder
  // key) — PERMANENT, no on-chain setter. Verified live: a BuilderCode from the 7-29
  // predict package whose internal owner == the founder wallet. This attaches to each
  // trader's account at mint (builderCodeEnabled=true) so the native builder fee
  // accrues to us. Override with NEXT_PUBLIC_BUILDER_CODE_ID to point at a code owned
  // by a different wallet (register it from that wallet at /v2/admin first).
  builderCodeId:
    process.env.NEXT_PUBLIC_BUILDER_CODE_ID ||
    '0x28808f158cbc3bdc0876dbc5dd2268e7801b21433f1daf878361fadf0b4dc76a',
  noLeverageWindowMs: 3_600_000, // 60 min: verified live — leverage is 1x within this window of expiry
  accumulatorRootId: '0x0000000000000000000000000000000000000000000000000000000000000acc',
  clockId: '0x6',
  quote: {
    coinType: '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC',
    currencyId: '0xf3000dff421833d4bb8ed58fac146d691a3aaba2785aa1989af65a7089ca3e9c',
    decimals: 6,
    symbol: 'DUSDC',
  },
  plpCoinType: '0xd94387c857ab56857f5f2750f2ba959fb007306f977a24290342433aef090298::plp::PLP',
  deepPackageId: '0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8',
  asset: {
    name: 'BTC_USD',
    propbookUnderlyingId: 1,
    pythFeedId: '0x980be0a52ea3f1e5243d5d5cd116c4de9107abb07fdbe134314996302a97c524',
    // 7-29 pricer takes two block-scholes feeds: value store, then svi store.
    // Phase-0 dry-run confirmed the 3-total-feed load_live_pricer (vs 6-24's four).
    bsFeedIds: [
      '0x24b684a5f9168bbe792e1e10aece0353e5e5f8f9be3d07acded253644f1c3d4c',
      '0x8400d1ea44291177bd02ff33d49be5785cc809cdf280f7e2f05f72866af05dca',
    ],
  },
  cadences: [
    { id: 0, name: '1m', tickSize: '10000000', admissionTickSize: '1000000000', maxExpiryAllocation: '50000000000', initialExpiryCash: '10000000000', windowSize: '3' },
    { id: 1, name: '5m', tickSize: '10000000', admissionTickSize: '1000000000', maxExpiryAllocation: '50000000000', initialExpiryCash: '10000000000', windowSize: '3' },
    { id: 2, name: '1h', tickSize: '10000000', admissionTickSize: '1000000000', maxExpiryAllocation: '250000000000', initialExpiryCash: '50000000000', windowSize: '3' },
  ],
  // 7-29 is a fresh deployment — no demo wallets to feature yet. Opt in via
  // NEXT_PUBLIC_FEATURED_WALLETS, or fill after we know who has traded.
  featuredWallets: process.env.NEXT_PUBLIC_FEATURED_WALLETS
    ? process.env.NEXT_PUBLIC_FEATURED_WALLETS.split(',').map((s) => s.trim()).filter(Boolean)
    : [],
  faucetUrl: 'https://tally.so/r/Xx102L',
};

// Mainnet v2 placeholders — fill on the eventual mainnet redeploy.
const V2_MAINNET: PredictV2Config = {
  ...V2_TESTNET,
  network: 'mainnet',
  grpcUrl: 'https://fullnode.mainnet.sui.io:443',
  serverUrl: '',
  oracleServerUrl: '',
  // Must NOT inherit testnet's code — a BuilderCode is bound to its registry and
  // its owner is permanent. Register a fresh one on mainnet FROM A MULTISIG (the
  // owning wallet must sign `create_builder_code` itself; there is no way to
  // reassign it later) and paste the id here.
  builderCodeId: '',
  // Testnet demo wallets must not leak onto a mainnet board; opt in explicitly.
  featuredWallets: [],
};

/** Testnet has two selectable deployments (6-24 default, 7-29 via the env switch);
 *  mainnet has one. */
const V2_TESTNET_BY_DEPLOYMENT: Record<PredictDeployment, PredictV2Config> = {
  '6-24': V2_TESTNET,
  '7-29': V2_TESTNET_729,
};

function selectV2Config(network: SuiNetwork): PredictV2Config {
  if (network === 'testnet') return V2_TESTNET_BY_DEPLOYMENT[ACTIVE_V2_DEPLOYMENT];
  return V2_MAINNET;
}

export const predictV2Config: PredictV2Config = selectV2Config(ACTIVE_NETWORK);

export function getPredictV2Config(network: SuiNetwork = ACTIVE_NETWORK): PredictV2Config {
  return selectV2Config(network);
}

/** True when the active-network v2 deployment has a server wired (testnet does). */
export const v2Deployed: boolean = !!predictV2Config.serverUrl;

/** True when our BuilderCode is registered for this network. False → mints never
 *  attach and the admin claim UI stays hidden; everything else is unaffected. */
export const builderCodeEnabled: boolean = !!predictV2Config.builderCodeId;

/**
 * Wallets allowed to see /v2/admin. v2 has no capability object to gate on (v1 had
 * the router's `AdminCap`), and BEFORE a code is registered there is nothing
 * on-chain that identifies the team — so bootstrapping needs an explicit list.
 *
 * This is UI-only and not a security boundary: `create_builder_code` is
 * permissionless (anyone can register a code for themselves anywhere), and
 * claiming is enforced by the chain's `assert_owner`. The list exists so founder
 * tooling isn't served to whoever guesses the URL.
 *
 * Override with NEXT_PUBLIC_ADMIN_ADDRESSES (comma-separated).
 */
export const adminAddresses: string[] = (
  process.env.NEXT_PUBLIC_ADMIN_ADDRESSES ||
  '0x33a8c34ae6f4dd41288ddb81c521b3c2a49c251abcc0926fe54c6376757ff3f4'
)
  .split(',')
  .map((a) => a.trim().toLowerCase())
  .filter(Boolean);

export const isAdminAddress = (addr: string | undefined | null): boolean =>
  !!addr && adminAddresses.includes(addr.toLowerCase());

/** Fully-qualified type helpers for the v2 predict package. */
export const v2Target = (
  module: string,
  fn: string,
): `${string}::${string}::${string}` =>
  `${predictV2Config.packages.predict}::${module}::${fn}` as const;

export const v2EventType = (module: string, name: string): string =>
  `${predictV2Config.packages.predict}::${module}::${name}`;
