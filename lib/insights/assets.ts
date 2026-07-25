/**
 * lib/insights/assets.ts — the asset registry the intelligence engine is keyed to.
 *
 * The whole engine (and the surfaces on top of it: the co-pilot, the Options page,
 * the future X bot) is asset-parametrized so that BTC → ETH → RWA is a config
 * choice, not a rewrite. An `AssetConfig` carries everything those surfaces need
 * that differs per asset: the Clawby symbol, the options venue we read positioning
 * from, display precision, and whether the asset is live yet.
 *
 * PURE + SERVER-SAFE: no React, no fetch. Sui protocol IDs stay in config/predict;
 * this file is only the market-intelligence view of an asset.
 */

export type AssetId = 'BTC' | 'ETH';

export interface AssetConfig {
  id: AssetId;
  /** Ticker used for Clawby coin params (`futures_coins_markets`, `option_max_pain`, …). */
  symbol: string;
  /** Full human label, e.g. for a page title. */
  label: string;
  /** Compact label for chips / tape, e.g. "BTC". */
  short: string;
  /** Decimal places a price is shown at (0 for BTC, it trades in whole dollars visually). */
  priceDecimals: number;
  /** Options exchange Clawby reads max-pain / OI from for this asset. */
  optionsExchange: string;
  /** Whether the Options page is enabled for this asset yet (Predict coverage gates it). */
  live: boolean;
}

export const ASSETS: Record<AssetId, AssetConfig> = {
  BTC: {
    id: 'BTC',
    symbol: 'BTC',
    label: 'Bitcoin',
    short: 'BTC',
    priceDecimals: 0,
    optionsExchange: 'Deribit',
    live: true,
  },
  ETH: {
    id: 'ETH',
    symbol: 'ETH',
    label: 'Ethereum',
    short: 'ETH',
    priceDecimals: 0,
    optionsExchange: 'Deribit',
    live: false,
  },
};

/** The asset the Options page opens on. */
export const DEFAULT_ASSET: AssetConfig = ASSETS.BTC;

/** Assets whose Options page is switched on today. */
export const LIVE_ASSETS: AssetConfig[] = Object.values(ASSETS).filter((a) => a.live);

/** Resolve an asset by id (case-insensitive); falls back to the default. Never throws,
 *  so a bad `?asset=` query param degrades to BTC instead of erroring the page. */
export function getAsset(id: string | null | undefined): AssetConfig {
  const key = id?.toUpperCase();
  if (key && key in ASSETS) return ASSETS[key as AssetId];
  return DEFAULT_ASSET;
}
