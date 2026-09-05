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
 * same UI. It only repoints contract IDs + the data source. A cutover / rollback is
 * this one env var (NEXT_PUBLIC_PREDICT_DEPLOYMENT).
 *
 * '8-06' is the current LIVE deployment: on 2026-08-06 Mysten REPUBLISHED the whole
 * Predict testnet stack (all-new package/object/feed IDs) under the reused
 * predict-testnet-7-29 branch and turned off the old writers — so both '6-24' and
 * '7-29' are permanently DEAD (frozen feeds, no mints). They remain here only for
 * reference / rollback-diagnosis. See the predict-refresh-8-06 notes for the full plan.
 */
export type PredictDeployment = '6-24' | '7-29' | '8-06' | '8-21';
const _DEPLOYMENT_ENV = process.env.NEXT_PUBLIC_PREDICT_DEPLOYMENT;
/** Every deployment this build can read, oldest first. Exported so a reader can answer
 *  "which deployment does this object belong to" instead of assuming the active one. */
export const KNOWN_V2_DEPLOYMENTS: readonly PredictDeployment[] = ['6-24', '7-29', '8-06', '8-21'];
const _KNOWN_DEPLOYMENTS = KNOWN_V2_DEPLOYMENTS;
export const ACTIVE_V2_DEPLOYMENT: PredictDeployment = _KNOWN_DEPLOYMENTS.includes(
  _DEPLOYMENT_ENV as PredictDeployment,
)
  ? (_DEPLOYMENT_ENV as PredictDeployment)
  : '8-06';

/**
 * True for the newer protocol shape shipped from the 7-29 deployment onward (7-29 and
 * 8-06): on-chain gRPC reads (no HTTP indexer), the 2-feed block-scholes pricer, the
 * account-model mint arguments, and the `create_and_share_builder_code` entry. 6-24 is
 * the older indexer protocol. Every place that used to test
 * `ACTIVE_V2_DEPLOYMENT === '7-29'` uses this instead, so a same-shape republish (like
 * 8-06) is covered automatically without touching each call site again.
 */
export const V2_IS_729_PLUS: boolean = ACTIVE_V2_DEPLOYMENT !== '6-24';

/**
 * True from the 8-21 deployment on. A SECOND shape flag is needed because 8-21 is not
 * another same-shape republish the way 8-06 was; two things changed under it that
 * `V2_IS_729_PLUS` cannot express:
 *
 *  1. LEVERAGE IS GONE protocol-side. `expiry_market::mint_exact_quantity` and
 *     `mint_exact_amount` each dropped their `leverage` argument (14 params → 13), and
 *     `redeem_settled_permissionless` dropped `close_quantity` (9 → 8). Verified by
 *     diffing the Move sources on the `predict-testnet-7-29` and `predict-testnet-8-21`
 *     branches; `redeem_live` and `redeem_settled` are byte-for-byte the same.
 *  2. HTTP INDEXERS EXIST AGAIN. 7-29 and 8-06 shipped none, so everything reads
 *     on-chain over gRPC. 8-21 has three (predict / propbook / account, all `-v4`),
 *     which reopens read paths that were closed for two deployments.
 *
 * Guard behaviour on this rather than on `ACTIVE_V2_DEPLOYMENT === '8-21'` so the next
 * same-shape republish is a config block and nothing else, which is exactly what
 * `V2_IS_729_PLUS` bought us when 8-06 landed.
 */
export const V2_IS_821_PLUS: boolean = ACTIVE_V2_DEPLOYMENT === '8-21';

export interface PredictV2Config {
  network: SuiNetwork;
  deployment: 'v2';
  grpcUrl: string;
  /** New beta indexer: /markets, /managers, /manager-orders, /supply-requests, … */
  serverUrl: string;
  /** Optional propbook oracle indexer (Pyth/Block-Scholes observation history). */
  oracleServerUrl: string;
  /** Optional account indexer (custody, balances, activity, portfolio, app auth).
   *  New in 8-21; empty on every earlier deployment. */
  accountServerUrl?: string;
  packages: {
    predict: string;
    account: string;
    propbook: string;
    blockScholesOracle: string;
    fixedMath: string;
    /** `deepbook_sessions` — delegate an ephemeral key to trade (kills the per-trade
     *  Slush popup). Empty on deployments where it is not published. See
     *  lib/sui/v2/session.ts. */
    sessions: string;
    /** The package that ORIGINALLY published `sessions` — the type-origin used to
     *  build the `SessionAuthorized` event type for a by-account-id scan (Move event
     *  types carry the origin, not the upgraded published-at). Lets the read layer
     *  discover an account's session keys even when no authorize is in the recent tx
     *  window. Optional; falls back to a type learned at runtime from a piggyback. */
    sessionsEventOrigin?: string;
    /** `deepbook_core_account` — the external-authorization app type that lets a Predict
     *  account act on DeepBook spot. New in 8-21, recorded for completeness; nothing
     *  reads it yet and `externalAuthorizations.deepbookCoreAccount.authorized` is
     *  false on the deployment as shipped. */
    deepbookCoreAccount?: string;
  };
  /** Shared objects passed into entry functions. */
  shared: {
    protocolConfig: string; // predict::protocol_config::ProtocolConfig
    poolVault: string; // predict::plp::PoolVault
    registry: string; // predict::registry::Registry
    oracleRegistry: string; // propbook::registry::OracleRegistry
    accountRegistry: string; // account::account_registry::AccountRegistry
    /** `deepbook_sessions::config::SessionsConfig`. Broken out as its own shared object
     *  in 8-21; earlier deployments carried the same settings inside the package. */
    sessionsConfig?: string;
    /** DeepBook core's own registry, needed only by the external-authorization flow. */
    deepbookRegistry?: string;
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
   * Our v2 `skew_fee_v2::fee_router` package + its shared `FeeConfig`. This is the
   * Skew fee (a % of each bet) charged ON TOP of the native builder fee, on-chain,
   * tunable from admin. BOTH empty = not deployed for this network → the app charges
   * no Skew fee and the UI never breaks. The live fee % + treasury are read on-chain
   * from `FeeConfig`, never hardcoded. See lib/sui/v2/skew-fee.ts. Framework-only, so
   * unlike the v1 router it survives protocol redeploys without re-publishing.
   */
  skewFeeV2PackageId: string;
  feeConfigV2Id: string;
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
    sessions: '', // not published on 6-24
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
  skewFeeV2PackageId: '', // dead deployment
  feeConfigV2Id: '',
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
    sessions: '', // 7-29 dead; sessions published on the 8-06 refresh
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
  skewFeeV2PackageId: '', // 7-29 dead; skew_fee_v2 published on the 8-06 refresh
  feeConfigV2Id: '',
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

/**
 * 8-06 deployment — the current LIVE testnet Predict. On 2026-08-06 Mysten REPUBLISHED
 * the entire stack with all-new package/object/feed IDs (new account wrapper, propbook,
 * predict, a new `sessions` package, and 6 cadences) and repointed the price-pusher to
 * it, turning off 6-24 and 7-29. IDs read verbatim from
 * packages/predict/deployment/deployment.testnet.json on branch predict-testnet-7-29
 * (upstream REUSED that branch name), sourceCommit 3072a370, schema v4, verified live
 * on-chain (pyth feed 0xccafaa6c… updating to the second). Re-check that JSON on any
 * future republish.
 *
 * Like 7-29: NO HTTP indexer (serverUrl/oracleServerUrl empty → on-chain gRPC reads),
 * and the pricer takes TWO block-scholes feeds (value store, then svi store).
 */
const V2_TESTNET_806: PredictV2Config = {
  network: 'testnet',
  deployment: 'v2',
  grpcUrl: 'https://fullnode.testnet.sui.io:443',
  serverUrl: '', // no 8-06 HTTP indexer — on-chain gRPC reads (lib/api/v2/onchain.ts)
  oracleServerUrl: '',
  packages: {
    predict: '0xfe742239a3b033f7d52ed5275f238c17d27498ca0ee5ea5672ea732eb3f4dbbb',
    account: '0xbdbb60b00f2d4f30daeff62f2c642b18433a8fcdfbebccc808df578df2a0c203',
    propbook: '0xed1295ff3c9a9415766afff20a74cdf2e362647be09aaf13b809302c0109e912',
    // 8-06 folds block-scholes into propbook; this is the price-updater's oracle
    // package (writers.priceUpdater.blockScholesOraclePackage). No code reads it.
    blockScholesOracle: '0x9d2cf38611d971a0e918b93fc0113d279f5c923f43e62c407a9ad0f9d82f6698',
    fixedMath: '0xdf0bd2a0d201562f2bdecb1b77d7998c7af316f6fd7d1eab9b9035064f21bfd4',
    // deepbook_sessions on 8-06 (Published.toml: published-at v2). Verified to target
    // this deployment's account/predict/config/registry objects. See [[sessions-delegated-trading]].
    sessions: '0x403ac487b19635c022f5c50378b9097ed7d80175f9b3ff7ea5a8a4a5fe0ecfbe',
    sessionsEventOrigin: '0x78887ffbb5e449776152c612fe05af03f729c02dbb7218c270e645c241ad527b',
  },
  shared: {
    protocolConfig: '0x43703ceee4d5f5a9e8cbf728071c34dc65961dd6e878fafd9ac36d86a9a4ce5b',
    poolVault: '0xeef535e7fcb850a943807ce48cc543c6d990b39e68a7bc47d0b56651ff20ab0a',
    registry: '0x35970bfd0ff3703cb38b3fff3a3fbb0bc0e5638e7c747af3a8e42e2c95d353f0',
    oracleRegistry: '0xc1dffc5f7a5404cb002ba3bd7c50d6a2dbe8bb6afd40080cd663965deff9d577',
    accountRegistry: '0x21a7ed28397363b5550853c1f08795731257de81028cd1bf87f20c0752c8ca2f',
  },
  // Re-register our BuilderCode on THIS deployment — a code is bound to its registry, so
  // the old 6-24/7-29 codes do not carry over. Until it is registered, mints fall back
  // to no-fee. Register from the founder wallet at /v2/admin, then set the id here or via
  // NEXT_PUBLIC_BUILDER_CODE_ID. See the builder-code-every-deployment rule.
  builderCodeId: process.env.NEXT_PUBLIC_BUILDER_CODE_ID || '',
  // skew_fee_v2 (module fee_router) — published on testnet 2026-08-19 by the deployer
  // 0x33a8c3…; AdminCap 0x49787e25…, UpgradeCap 0xb2ef71b4…. FeeConfig defaults: 50 bps
  // (0.50%), treasury = deployer (verified on-chain). Charged on top of the builder fee.
  skewFeeV2PackageId:
    process.env.NEXT_PUBLIC_SKEW_FEE_V2_PACKAGE_ID ||
    '0xd3f63b410046b5fa709174f319eac07c1728bcdb192771aad89d79afc44adc71',
  feeConfigV2Id:
    process.env.NEXT_PUBLIC_SKEW_FEE_V2_CONFIG_ID ||
    '0xe791646b2e5761d650c0ddd3e4db656430e4d31863ccc13613c845572a6520fb',
  noLeverageWindowMs: 3_600_000, // futureMarketTemplate.noLeverageWindowMs (60 min)
  accumulatorRootId: '0x0000000000000000000000000000000000000000000000000000000000000acc',
  clockId: '0x6',
  quote: {
    coinType: '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC',
    currencyId: '0xf3000dff421833d4bb8ed58fac146d691a3aaba2785aa1989af65a7089ca3e9c',
    decimals: 6,
    symbol: 'DUSDC',
  },
  plpCoinType: '0xfe742239a3b033f7d52ed5275f238c17d27498ca0ee5ea5672ea732eb3f4dbbb::plp::PLP',
  deepPackageId: '0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8',
  asset: {
    name: 'BTC_USD',
    propbookUnderlyingId: 1,
    pythFeedId: '0xccafaa6c5a41f0493585cf268f2b4dc14c91ed798362444144cac2c745db8dde',
    // Two block-scholes feeds (value store, then svi store) — same shape as 7-29.
    bsFeedIds: [
      '0x6d9de17954f4c1a2f01fdd97c0bb8a2e682c1fea0f8f048dcd127d543a6ac051',
      '0x83c2d6307fd3591228052fc0d24c4f00a698b0eb4fef5e6083a213ca0d54bd35',
    ],
  },
  // Only the three enabled sub-hour cadences; 1d/1w/1mo ship enabled=false / tick 0
  // upstream (not tradeable yet). Values verbatim from initialConfiguration.cadences.
  cadences: [
    { id: 0, name: '1m', tickSize: '10000000', admissionTickSize: '1000000000', maxExpiryAllocation: '50000000000', initialExpiryCash: '10000000000', windowSize: '3' },
    { id: 1, name: '5m', tickSize: '10000000', admissionTickSize: '1000000000', maxExpiryAllocation: '50000000000', initialExpiryCash: '10000000000', windowSize: '3' },
    { id: 2, name: '1h', tickSize: '10000000', admissionTickSize: '1000000000', maxExpiryAllocation: '250000000000', initialExpiryCash: '50000000000', windowSize: '3' },
  ],
  // Fresh deployment — no demo wallets to feature yet. Opt in via NEXT_PUBLIC_FEATURED_WALLETS.
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
  // Must NOT inherit testnet's skew_fee_v2 — publish it on mainnet (from a multisig) and
  // paste the ids here, or the app would charge against a testnet FeeConfig.
  skewFeeV2PackageId: '',
  feeConfigV2Id: '',
  // Testnet demo wallets must not leak onto a mainnet board; opt in explicitly.
  featuredWallets: [],
};

/**
 * 8-21 — the deployment recorded on the `predict-testnet-8-21` branch (manifest
 * schemaVersion 6, sourceCommit 1f79fe87). IDs are verbatim from
 * `packages/predict/deployment/deployment.testnet.json` on that branch.
 *
 * UNLIKE EVERY PRIOR REPUBLISH, THIS ONE DID NOT KILL ITS PREDECESSOR. 6-24 → 7-29 →
 * 8-06 each turned the old writers off; 8-21 has run alongside a fully live 8-06 for
 * ten days (both registries and both pyth feeds writing seconds apart, verified
 * 2026-08-31). So there is no forced cutover here and rollback is one env var.
 *
 * WHAT IT BRINGS: the ladder. 1d and 1w cadences are `enabled: true` with real tick
 * sizes, and the live market list runs from one minute out to nine and a half days.
 * 8-06 tops out around twelve minutes.
 */
const V2_TESTNET_821: PredictV2Config = {
  network: 'testnet',
  deployment: 'v2',
  grpcUrl: 'https://fullnode.testnet.sui.io:443',
  // Three HTTP indexers again, after two deployments with none. Documented in
  // packages/predict/deployment/INTEGRATION.md; all three answered `status: OK` when
  // this block was written. They are operational endpoints, NOT part of the audited
  // manifest, so treat them as a convenience over the chain rather than an authority.
  serverUrl: 'https://predict-server-v4.testnet.mystenlabs.com',
  oracleServerUrl: 'https://propbook-server-v4.testnet.mystenlabs.com',
  accountServerUrl: 'https://account-server-v4.testnet.mystenlabs.com',
  packages: {
    predict: '0x421041754244cf0e985fb9c9f5e1f49428caf3df4cde3a7b266d8e18ea63597b',
    account: '0xa94ec89b6cbb3e2609c7ca65bd77885b7513f852922ebdf8e766851fb6f85259',
    propbook: '0xd8b402609b1728f60cf20bfaaec5255701df54350ec13e93aac39463b00bf97b',
    // writers.priceUpdater.blockScholesOraclePackage — unchanged from 8-06, and still
    // read by nothing in the app.
    blockScholesOracle: '0x9d2cf38611d971a0e918b93fc0113d279f5c923f43e62c407a9ad0f9d82f6698',
    fixedMath: '0xa55ad273d714c0688354cfe057073b64cd7e89ca1807f570a1505b8ee6c1abe3',
    sessions: '0xb74170443d6d2d37cbe95c7e530dd4a1605ef714ff4f9e88e27a7ac1455451db',
    // Freshly published rather than upgraded, so published-at IS the type origin here.
    // (On 8-06 they differ, which is why the field exists at all.)
    sessionsEventOrigin: '0xb74170443d6d2d37cbe95c7e530dd4a1605ef714ff4f9e88e27a7ac1455451db',
    deepbookCoreAccount: '0xcc9cf1029127e7bda6da4c2ab90164d7bef751783ff13c21c2bb804cec69ebec',
  },
  shared: {
    protocolConfig: '0x7ef1ac99c2f0a77e7aa2602b5ea7bff68750cff0d80f09bdf827bfb345128f33',
    poolVault: '0x2a31f592d8fd3d0781e2233770d02d67797890ac82c3d18796d7eb0997896602',
    registry: '0x3d486bd50bb5bb5450ddbcb4f74776b6135f416c09024a6674ac266e77e1870a',
    oracleRegistry: '0x715f5ae4aac0078f4d0c6bf9ea2815614e799e909a90b577aeb8de9ad8bab142',
    accountRegistry: '0x5682c73d657de1546374e632369a25c82744c8a20e9b4f47e6558e3d4bde88d3',
    sessionsConfig: '0xdfb8e23246678649cfdd6f3f6610057d5cadd6a8911a21dbe8e34788abbfab93',
    deepbookRegistry: '0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1',
  },
  // A BuilderCode is bound to the registry that created it, so 8-06's code does NOT
  // carry over. Re-register from the founder wallet at /v2/admin and set
  // NEXT_PUBLIC_BUILDER_CODE_ID_821. Until then mints fall back to no-fee, which is why
  // this deliberately does NOT fall back to the 8-06 env var: a stale id would attach a
  // code this registry has never heard of. See the builder-code-every-deployment rule.
  builderCodeId: process.env.NEXT_PUBLIC_BUILDER_CODE_ID_821 || '',
  // skew_fee_v2 is framework-only (it moves DUSDC between accounts and never calls into
  // the predict package), so the SAME published package works across redeploys. Its
  // FeeConfig / AdminCap are per-object, not per-deployment, so they carry over too.
  // Both still get re-verified on chain during cutover rather than assumed.
  skewFeeV2PackageId:
    process.env.NEXT_PUBLIC_SKEW_FEE_V2_PACKAGE_ID ||
    '0xd3f63b410046b5fa709174f319eac07c1728bcdb192771aad89d79afc44adc71',
  feeConfigV2Id:
    process.env.NEXT_PUBLIC_SKEW_FEE_V2_CONFIG_ID ||
    '0xe791646b2e5761d650c0ddd3e4db656430e4d31863ccc13613c845572a6520fb',
  // 0 because leverage no longer exists on this protocol (#1236). The window was the
  // ceiling on a feature that has been removed, not a setting that went to zero.
  noLeverageWindowMs: 0,
  accumulatorRootId: '0x0000000000000000000000000000000000000000000000000000000000000acc',
  clockId: '0x6',
  quote: {
    // DUSDC is unchanged across every deployment so far.
    coinType: '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC',
    currencyId: '0xf3000dff421833d4bb8ed58fac146d691a3aaba2785aa1989af65a7089ca3e9c',
    decimals: 6,
    symbol: 'DUSDC',
  },
  plpCoinType: '0x421041754244cf0e985fb9c9f5e1f49428caf3df4cde3a7b266d8e18ea63597b::plp::PLP',
  deepPackageId: '0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8',
  asset: {
    name: 'BTC_USD',
    propbookUnderlyingId: 1,
    pythFeedId: '0xea8fd4624002516b28b495051c838b2c9a34a4f22ae281d328e1bec47f54cd24',
    // Same two-feed shape as 7-29 / 8-06: value store, then svi store.
    bsFeedIds: [
      '0x9b64cc860ac09e6dcd675fc579c1048792ddce51cc018f2ca16aeb4a1a5684a3',
      '0xd5bc586e99c8d595e0ba5e0a2ef2295e652db8934ffbeda630d60e207bedab8f',
    ],
  },
  // FIVE enabled cadences, not three. 1d and 1w are live here with a $100 admission
  // grid (admissionTickSize 1e11) against the $1 grid the sub-hour ones use. 1mo is
  // still shipped disabled with tick 0, so it stays out. Verbatim from
  // initialConfiguration.cadences.BTC.
  cadences: [
    { id: 0, name: '1m', tickSize: '10000000', admissionTickSize: '1000000000', maxExpiryAllocation: '50000000000', initialExpiryCash: '10000000000', windowSize: '2' },
    { id: 1, name: '5m', tickSize: '10000000', admissionTickSize: '1000000000', maxExpiryAllocation: '50000000000', initialExpiryCash: '10000000000', windowSize: '2' },
    { id: 2, name: '1h', tickSize: '10000000', admissionTickSize: '1000000000', maxExpiryAllocation: '250000000000', initialExpiryCash: '50000000000', windowSize: '2' },
    { id: 3, name: '1d', tickSize: '10000000', admissionTickSize: '100000000000', maxExpiryAllocation: '250000000000', initialExpiryCash: '50000000000', windowSize: '2' },
    { id: 4, name: '1w', tickSize: '10000000', admissionTickSize: '100000000000', maxExpiryAllocation: '250000000000', initialExpiryCash: '50000000000', windowSize: '2' },
  ],
  featuredWallets: process.env.NEXT_PUBLIC_FEATURED_WALLETS
    ? process.env.NEXT_PUBLIC_FEATURED_WALLETS.split(',').map((s) => s.trim()).filter(Boolean)
    : [],
  faucetUrl: 'https://tally.so/r/Xx102L',
};

/** Testnet deployments, selected with NEXT_PUBLIC_PREDICT_DEPLOYMENT. 8-06 is still the
 *  default: 8-21 is wired and selectable but not yet cut over. 6-24 and 7-29 are dead
 *  and kept only for reference and rollback diagnosis. Mainnet has one. */
const V2_TESTNET_BY_DEPLOYMENT: Record<PredictDeployment, PredictV2Config> = {
  '6-24': V2_TESTNET,
  '7-29': V2_TESTNET_729,
  '8-06': V2_TESTNET_806,
  '8-21': V2_TESTNET_821,
};

function selectV2Config(network: SuiNetwork): PredictV2Config {
  if (network === 'testnet') return V2_TESTNET_BY_DEPLOYMENT[ACTIVE_V2_DEPLOYMENT];
  return V2_MAINNET;
}

/**
 * A specific deployment's config, whichever one we are running.
 *
 * Needed because a redeploy STRANDS money. Accounts are per deployment: the custody object,
 * the registry that derives it, and the coin sitting in it all belong to the release that
 * created them. Cutting over to 8-21 does not move a trader's DUSDC, it just stops the app
 * from ever looking at where the DUSDC is. So the app has to be able to read, and withdraw
 * from, a deployment it is not otherwise using.
 */
export function predictConfigFor(deployment: PredictDeployment): PredictV2Config {
  return V2_TESTNET_BY_DEPLOYMENT[deployment];
}

/** `0x` + 64 lowercase hex, so a short or upper-case form of the same address compares equal. */
function canonicalAddress(addr: string): string {
  const hex = addr.trim().toLowerCase().replace(/^0x/, '');
  return hex && /^[0-9a-f]+$/.test(hex) ? `0x${hex.padStart(64, '0')}` : '';
}

/**
 * The deployment whose predict package DEFINED an object, from that object's Move type (or
 * a bare package address), or null when the package is not one of ours.
 *
 * A market id alone is ambiguous after a republish. Every deployment has its own
 * `expiry_market::ExpiryMarket` type, and a view getter from the 8-21 package aborts on an
 * 8-06 object, so anything that reads settled markets across a cutover (Kelly's track record
 * scores calls made weeks ago) has to pick the package the object came from. The type's
 * address is the ORIGINAL package id; every testnet deployment is still at version 1, so it
 * matches `packages.predict` directly. The newest deployment wins if two ever shared one.
 */
export function deploymentForPredictPackage(packageOrType: string): PredictDeployment | null {
  const pkg = canonicalAddress(packageOrType.split('::')[0] ?? '');
  if (!pkg) return null;
  for (let i = KNOWN_V2_DEPLOYMENTS.length - 1; i >= 0; i--) {
    const d = KNOWN_V2_DEPLOYMENTS[i];
    const p = canonicalAddress(V2_TESTNET_BY_DEPLOYMENT[d].packages.predict);
    if (p && p === pkg) return d;
  }
  return null;
}

/**
 * The deployment we migrated FROM, or null when there is nothing behind us.
 *
 * Only the immediately previous one. Funds could in principle be stranded further back, but
 * 6-24 and 7-29 are long dead and their balances were already swept forward, so offering to
 * check them would be a prompt about nothing for every trader who ever sees it.
 */
export const PREVIOUS_V2_DEPLOYMENT: PredictDeployment | null =
  ACTIVE_V2_DEPLOYMENT === '8-21' ? '8-06' : ACTIVE_V2_DEPLOYMENT === '8-06' ? '7-29' : null;

export const predictV2Config: PredictV2Config = selectV2Config(ACTIVE_NETWORK);

export function getPredictV2Config(network: SuiNetwork = ACTIVE_NETWORK): PredictV2Config {
  return selectV2Config(network);
}

/** True when the active-network v2 deployment is live. Keyed off the predict PACKAGE,
 *  not the HTTP `serverUrl`: from the 7-29 deployment on the app reads on-chain via
 *  gRPC and ships NO indexer server (`serverUrl: ''`), so a serverUrl check wrongly
 *  reported the live gRPC deployment as "not deployed" and left the Latest toggle a
 *  disabled "Soon" teaser. A real deployment always has a predict package id. */
export const v2Deployed: boolean = !!predictV2Config.packages.predict;

/** True when our BuilderCode is registered for this network. False → mints never
 *  attach and the admin claim UI stays hidden; everything else is unaffected. */
export const builderCodeEnabled: boolean = !!predictV2Config.builderCodeId;

/** True when the v2 skew_fee router is published for this network. False → mints charge
 *  NO Skew fee (the fee line is hidden and the admin panel stays in projection-only mode);
 *  everything else is unaffected. */
export const feeRouterV2Enabled: boolean =
  !!predictV2Config.skewFeeV2PackageId && !!predictV2Config.feeConfigV2Id;

/** Fully-qualified target in our `skew_fee_v2` package (module `fee_router`). */
export const v2SkewFeeTarget = (fn: string): `${string}::fee_router::${string}` =>
  `${predictV2Config.skewFeeV2PackageId}::fee_router::${fn}` as const;

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

/** Fully-qualified target in the `deepbook_sessions` package (delegated trading). */
export const v2SessionTarget = (
  module: string,
  fn: string,
): `${string}::${string}::${string}` =>
  `${predictV2Config.packages.sessions}::${module}::${fn}` as const;

/**
 * Delegated-trading sessions ([[sessions-delegated-trading]]): authorize an ephemeral
 * key ONCE, then trade popup-less. Available only when the package is published on the
 * active deployment AND the flag is set — ships DARK so the existing Slush/Enoki paths
 * are untouched until we explicitly turn it on.
 */
export const V2_SESSIONS_ENABLED: boolean =
  !!predictV2Config.packages.sessions && process.env.NEXT_PUBLIC_SESSIONS === '1';

/**
 * Simple mode ([[simple-mode]]): a stripped-down UP/DOWN "round" trade screen at
 * `/v2/simple`, reachable via a Easy ⇄ Pro toggle that shows only on the
 * trade screen. Reuses the same markets / pricer / mint plumbing as the full
 * ticket — it's a calmer front-end, not a second engine, so its trades still land
 * on the leaderboard, portfolio, and PnL like any other. Ships DARK behind the
 * flag so the full terminal stays the only trade experience until we turn it on.
 */
export const V2_SIMPLE_ENABLED: boolean = process.env.NEXT_PUBLIC_SIMPLE_MODE === '1';

/**
 * The first-visit experience prompt: one modal on landing asking whether the visitor is
 * new to prediction markets or already trades, then sending them to the matching screen.
 *
 * Its own flag, but hard-ANDed with `V2_SIMPLE_ENABLED` — offering a choice between two
 * screens when one of them is switched off would send half of all new traders to a
 * redirect. Turning simple mode off therefore turns this off with it, and there is no
 * env combination that can put the prompt in front of a visitor it cannot serve.
 */
export const V2_EXPERIENCE_PROMPT_ENABLED: boolean =
  V2_SIMPLE_ENABLED && process.env.NEXT_PUBLIC_EXPERIENCE_PROMPT === '1';
