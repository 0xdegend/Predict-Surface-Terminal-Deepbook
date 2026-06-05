/**
 * keeper/src/config.mjs — protocol IDs + endpoints, keyed by network.
 *
 * Deliberately a standalone copy of the app's config/predict.ts (this is a
 * separate service with its own deploy lifecycle). Mainnet cutover = set
 * SUI_NETWORK=mainnet and fill the MAINNET block. Nothing else hardcodes IDs.
 */

const TESTNET = {
  network: 'testnet',
  jsonRpcUrl: 'https://fullnode.testnet.sui.io:443',
  serverUrl: 'https://predict-server.testnet.mystenlabs.com',
  packageId: '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138',
  predictObjectId: '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a',
  clockId: '0x6',
  quoteCoinType:
    '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC',
  quoteDecimals: 6,
  explorer: 'https://suiscan.xyz/testnet',
};

// Fill on mainnet redeploy — day-one swap is a config edit + env flip.
const MAINNET = {
  network: 'mainnet',
  jsonRpcUrl: 'https://fullnode.mainnet.sui.io:443',
  serverUrl: '', // TODO
  packageId: '', // TODO
  predictObjectId: '', // TODO
  clockId: '0x6',
  quoteCoinType: '', // TODO
  quoteDecimals: 6,
  explorer: 'https://suiscan.xyz/mainnet',
};

const CONFIGS = { testnet: TESTNET, mainnet: MAINNET };

export function loadConfig() {
  const network = process.env.SUI_NETWORK || 'testnet';
  const cfg = CONFIGS[network];
  if (!cfg) throw new Error(`Unknown SUI_NETWORK: ${network}`);
  if (!cfg.packageId) throw new Error(`Config for ${network} is not filled in yet.`);
  return cfg;
}

/** DUSDC base units → human float (display/logging only). */
export function fromQuote(base, cfg) {
  return Number(base) / 10 ** cfg.quoteDecimals;
}
