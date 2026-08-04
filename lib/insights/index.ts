/**
 * lib/insights — the shared market-intelligence engine (public entry).
 *
 * Import from here (`@/lib/insights`) to read any market figure: the co-pilot,
 * the BTC Options page, and the future X bot all pull from this one brain, so the
 * numbers on every surface stay in lockstep.
 *
 *   import { buildMarketIntel, getAsset, type MarketIntel } from '@/lib/insights';
 *
 * Everything re-exported here is PURE + SERVER-SAFE — no React, no fetch — so a
 * Next route handler or a scheduled job can use it directly.
 */
export * from './context';
export * from './assets';
export * from './expected-move';
export * from './engine';
export * from './market-read';
export * from './strike-analysis';
export * from './edge-scan';
export * from './greeks';
export * from './positioning';
export * from './positioning-read';
export * from './consensus';
export * from './narrative';
