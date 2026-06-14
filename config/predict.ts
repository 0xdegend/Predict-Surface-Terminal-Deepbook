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
