/**
 * lib/api/v2/client.ts — typed fetch wrapper for the NEW Predict beta indexer
 * (markets/state/status) and the propbook oracle indexer (pyth spot + bindings).
 *
 * Pure functions (no React) so they work from Server Components, queryFns, and
 * scripts. Base URLs come from config/predict.ts (predictV2Config). Reuses the
 * shared PredictApiError + humanizeApiError so error UX matches the legacy app.
 *
 * NOTE (verified live 2026-06-27): the beta server's /managers, /manager-orders,
 * /market-orders, /supply-requests endpoints currently 404 — they're portfolio/LP
 * concerns wired up in Phases 2–3. Phase 1 only needs markets + status + pyth.
 */
import { predictV2Config } from '@/config/predict';
import { PredictApiError } from '@/lib/api/client';
import type {
  V2Market,
  V2MarketState,
  V2Status,
  PythObservation,
  OracleBinding,
  V2Position,
  V2OrderEvent,
  V2VaultServerState,
  V2VaultFlush,
  V2VaultProfit,
  V2VaultFlow,
  V2BuilderFee,
  V2PositionCashflow,
  V2OpenInterest,
  V2ActivityBucket,
  V2LiquidationBucket,
} from './types';

interface GetOptions {
  /** Next.js fetch cache control. Default: no-store for live data. */
  revalidate?: number | false;
  signal?: AbortSignal;
}

async function getFrom<T>(base: string, path: string, opts: GetOptions = {}): Promise<T> {
  const url = `${base}${path}`;
  const cache: RequestCache | undefined = opts.revalidate === undefined ? 'no-store' : undefined;
  const next =
    opts.revalidate !== undefined && opts.revalidate !== false
      ? { revalidate: opts.revalidate }
      : undefined;
  const res = await fetch(url, { cache, next, signal: opts.signal });
  if (!res.ok) throw new PredictApiError(`GET ${path} → ${res.status}`, res.status, url);
  return (await res.json()) as T;
}

const beta = <T>(path: string, o?: GetOptions) => getFrom<T>(predictV2Config.serverUrl, path, o);
const propbook = <T>(path: string, o?: GetOptions) =>
  getFrom<T>(predictV2Config.oracleServerUrl, path, o);

/* ------------------------------ beta server ------------------------------ */

export const getV2Status = (o?: GetOptions) => beta<V2Status>('/status', o);

/** All `MarketCreated` rows (newest-first). Filter to active via v2-discovery. */
export const getV2Markets = (limit = 100, o?: GetOptions) =>
  beta<V2Market[]>(`/markets?limit=${limit}`, o);

export const getV2MarketState = (marketId: string, o?: GetOptions) =>
  beta<V2MarketState>(`/markets/${marketId}/state`, o);

/** Open positions for an ACCOUNT id (the internal account_id from events, NOT
 *  the wallet owner — the indexer keys positions/orders under account_id). */
export const getAccountPositions = (accountId: string, o?: GetOptions) =>
  beta<V2Position[]>(`/accounts/${accountId}/positions`, o);

/** The account's order EVENT log (mints + redeems) — the source for trade
 *  history, portfolio positions, and the leaderboard completeness fold. The
 *  server DEFAULTS to only 50 rows and hard-caps at 500 (verified live
 *  2026-07-18), so request the full 500 explicitly — the 50-row default was
 *  silently truncating active wallets' history. */
export const getAccountOrders = (accountId: string, limit = 500, o?: GetOptions) =>
  beta<V2OrderEvent[]>(`/accounts/${accountId}/orders?limit=${limit}`, o);

/** Vault NAV + latest flush/fill events — pool_value/total_supply give the live
 *  share price (endpoint shipped ~2026-07, verified live 2026-07-08). */
export const getVaultState = (vaultId: string, o?: GetOptions) =>
  beta<V2VaultServerState>(`/vaults/${vaultId}/state`, o);

/** Keeper flush history (newest-first). Each flush marks the pool at that moment,
 *  so pool_value/total_supply per flush IS the share-price series over time — the
 *  v2 stand-in for legacy's `/vault/performance` (which v2 doesn't expose). */
export const getVaultFlushes = (vaultId: string, limit = 200, o?: GetOptions) =>
  beta<V2VaultFlush[]>(`/vaults/${vaultId}/flushes?limit=${limit}`, o);

/** Realized profit per market settlement (LP + protocol split), newest-first —
 *  drives the vault performance panel's cumulative LP-profit series. */
export const getVaultProfit = (vaultId: string, limit = 200, o?: GetOptions) =>
  beta<V2VaultProfit[]>(`/vaults/${vaultId}/profit?limit=${limit}`, o);

/** Hourly supply/withdraw activity buckets for the vault (`total_supply_after`
 *  over time = a share-supply series to complement the flush share-price one). */
export const getVaultFlows = (vaultId: string, limit = 200, o?: GetOptions) =>
  beta<V2VaultFlow[]>(`/vaults/${vaultId}/flows?limit=${limit}`, o);

/** Builder-fee CLAIM history for a code — sum of `amount` = lifetime swept. */
export const getBuilderCodeFees = (codeId: string, limit = 200, o?: GetOptions) =>
  beta<V2BuilderFee[]>(`/builder-codes/${codeId}/fees?limit=${limit}`, o);

/** Authoritative per-position cost/payout roll-up. `null` while still open, so
 *  callers keep the client-side order derivation as the fallback. */
export const getPositionCashflow = (marketId: string, positionRootId: string, o?: GetOptions) =>
  beta<V2PositionCashflow | null>(`/markets/${marketId}/positions/${positionRootId}/cashflow`, o);

/** Open positions + max payout at risk for one market. */
export const getMarketOpenInterest = (marketId: string, o?: GetOptions) =>
  beta<V2OpenInterest>(`/markets/${marketId}/open-interest`, o);

/** The market's order EVENT log (mints + redeems), newest-first — the per-market
 *  flow feed. There is no GLOBAL orders endpoint, so the analytics aggregate fans
 *  this out across the active markets to reconstruct the whole book's flow. */
export const getMarketOrders = (marketId: string, limit = 60, o?: GetOptions) =>
  beta<V2OrderEvent[]>(`/markets/${marketId}/orders?limit=${limit}`, o);

/** Hourly mint/redeem activity buckets for one market (30-day MV, 60s refresh). */
export const getMarketActivity = (marketId: string, limit = 50, o?: GetOptions) =>
  beta<V2ActivityBucket[]>(`/markets/${marketId}/activity?limit=${limit}`, o);

/** Hourly liquidation buckets for one market (30-day MV, 60s refresh). */
export const getMarketLiquidationStats = (marketId: string, limit = 50, o?: GetOptions) =>
  beta<V2LiquidationBucket[]>(`/markets/${marketId}/liquidation-stats?limit=${limit}`, o);

/* --------------------------- propbook indexer ---------------------------- */

export const getPropbookStatus = (o?: GetOptions) => propbook<V2Status>('/status', o);

export const getOracleBindings = (o?: GetOptions) =>
  propbook<OracleBinding[]>('/oracle-bindings', o);

/** Latest raw Pyth spot observation for the underlying's pyth feed object id. */
export const getPythLatest = (pythOracleId: string, o?: GetOptions) =>
  propbook<PythObservation | null>(`/oracles/${pythOracleId}/pyth/latest`, o);

/** Recent Pyth spot observation history (for the price chart). */
export const getPythHistory = (pythOracleId: string, limit = 300, o?: GetOptions) =>
  propbook<PythObservation[]>(`/oracles/${pythOracleId}/pyth?limit=${limit}`, o);

/** Decode a raw Pyth observation into a spot float (price · 10^±exp). */
export function pythSpot(obs: PythObservation | null): number | null {
  if (!obs) return null;
  const mag = Number(obs.price_magnitude) * (obs.price_is_negative ? -1 : 1);
  const exp = obs.exponent_magnitude * (obs.exponent_is_negative ? -1 : 1);
  return mag * 10 ** exp;
}

/* ------------------------- TanStack query keys --------------------------- */

export const qkV2 = {
  status: ['v2', 'status'] as const,
  markets: ['v2', 'markets'] as const,
  marketState: (id: string) => ['v2', 'market', id, 'state'] as const,
  pythLatest: ['v2', 'pyth', 'latest'] as const,
  pythHistory: ['v2', 'pyth', 'history'] as const,
  pricer: (id: string) => ['v2', 'pricer', id] as const,
  accountPositions: (accountId: string) => ['v2', 'account', accountId, 'positions'] as const,
  accountOrders: (accountId: string) => ['v2', 'account', accountId, 'orders'] as const,
  vaultServerState: ['v2', 'vault', 'server-state'] as const,
  vaultFlushes: ['v2', 'vault', 'flushes'] as const,
  vaultProfit: ['v2', 'vault', 'profit'] as const,
  vaultFlows: ['v2', 'vault', 'flows'] as const,
  builderCodeFees: (id: string) => ['v2', 'builder-code', id, 'fees'] as const,
  positionCashflow: (marketId: string, root: string) =>
    ['v2', 'market', marketId, 'position', root, 'cashflow'] as const,
  marketOpenInterest: (id: string) => ['v2', 'market', id, 'open-interest'] as const,
  marketActivity: (id: string) => ['v2', 'market', id, 'activity'] as const,
  marketOrders: (id: string) => ['v2', 'market', id, 'orders'] as const,
};
