/**
 * keeper/v2/config.mjs — IDs + endpoints for the NEW (v2) deployment.
 * Standalone copy of the app's V2_TESTNET (separate service lifecycle). Mainnet
 * cutover = SUI_NETWORK=mainnet + fill MAINNET.
 */
const TESTNET = {
  network: 'testnet',
  jsonRpcUrl: 'https://fullnode.testnet.sui.io:443',
  serverUrl: 'https://predict-server-beta.testnet.mystenlabs.com',
  oracleServerUrl: 'https://propbook.api.testnet.mystenlabs.com',
  packageId: '0xdb3ef5a5129920e59c9b2ae25a77eddb48acd0e1c6307b97073f0e076016446e',
  accountPackageId: '0xb9389eac8d59170ffd1427c1a66e5c8306263464fcc6615e825c1f5b3e15da3b',
  protocolConfigId: '0x2325224629b4bd96d1f1d7ee937e07f8a06f861018a130bbb26db09cb0394cb6',
  oracleRegistryId: '0xf3deaff68cbd081a35ec21653af6f671d2ad5f012f3b4d817d81752843374136',
  accountRegistryId: '0x3c54d5b8b6bca376fc289121838ad02f8a5b3843242b9ad7e8f8245720e685a2',
  accumulatorRootId: '0x0000000000000000000000000000000000000000000000000000000000000acc',
  clockId: '0x6',
  pythFeedId: '0xc78d7de16217d46d21b92ae475da799448be30b71a758dc6d7bb3ac2f1c35afb',
  bsSpotFeedId: '0xcdc5fa7364e60fd2504aa96f65b707dc0734e507a919b1a7d7d63164fd67b745',
  bsForwardFeedId: '0xe72c734ea8d8dcbc9183d9d8f96f51aaa1fb5034d5ed33ac60d67d261e15b48a',
  bsSviFeedId: '0xdc2f8270676bd05fb28491e8d4a41a495722fda7a454926dd66dbba256a21c69',
  quoteDecimals: 6,
  explorer: 'https://suiscan.xyz/testnet',
};

const MAINNET = { ...TESTNET, network: 'mainnet', jsonRpcUrl: 'https://fullnode.mainnet.sui.io:443', serverUrl: '', oracleServerUrl: '', explorer: 'https://suiscan.xyz/mainnet' };

const CONFIGS = { testnet: TESTNET, mainnet: MAINNET };

/** +∞ strike sentinel ((1<<30)-1) — a higher_tick of this means "settles above". */
export const POS_INF_TICK = 1_073_741_823n;

export function loadConfig() {
  const network = process.env.SUI_NETWORK || 'testnet';
  const cfg = CONFIGS[network];
  if (!cfg) throw new Error(`Unknown SUI_NETWORK: ${network}`);
  if (!cfg.serverUrl) throw new Error(`Config for ${network} is not filled in yet.`);
  return cfg;
}

export const fromQuote = (base, cfg) => Number(base) / 10 ** cfg.quoteDecimals;
