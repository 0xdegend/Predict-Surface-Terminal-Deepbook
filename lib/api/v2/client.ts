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
import { predictV2Config, V2_IS_729_PLUS } from '@/config/predict';
import { PredictApiError } from '@/lib/api/client';
import {
  onchainMarkets,
  onchainPythObservations,
  onchainPythLatest,
  onchainMarketState,
  onchainAccountOrders,
  onchainOwnerOrders,
  onchainAccountPositions,
  onchainOwnerPositions,
  onchainMarketOrders,
  onchainAllOrders,
  onchainMarketOpenInterest,
  onchainVaultState,
  onchainVaultFlushes,
  onchainVaultProfit,
  onchainVaultSupplyFills,
  onchainVaultWithdrawFills,
  onchainBuilderCodeFees,
} from './onchain';
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
  V2VaultSupplyFill,
  V2VaultWithdrawFill,
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

// 7-29 has no HTTP indexer; synthesize a healthy status so status widgets don't
// fetch the empty server URL. current_time_ms drives client clocks only.
const synthStatus = (): V2Status => ({
  status: 'OK',
  latest_onchain_checkpoint: 0,
  current_time_ms: Date.now(),
});

export const getV2Status = (o?: GetOptions): Promise<V2Status> =>
  V2_IS_729_PLUS ? Promise.resolve(synthStatus()) : beta<V2Status>('/status', o);

/** All `MarketCreated` rows (newest-first). Filter to active via v2-discovery. On
 *  7-29 these come from the chain's own event index (see lib/api/v2/onchain.ts). */
export const getV2Markets = (limit = 100, o?: GetOptions) =>
  V2_IS_729_PLUS
    ? onchainMarkets(limit, o)
    : beta<V2Market[]>(`/markets?limit=${limit}`, o);

export const getV2MarketState = (marketId: string, o?: GetOptions) =>
  V2_IS_729_PLUS
    ? onchainMarketState(marketId)
    : beta<V2MarketState>(`/markets/${marketId}/state`, o);

/** Open positions for an ACCOUNT id (the internal account_id from events, NOT the
 *  wallet owner — positions/orders are keyed under account_id). This is the
 *  portfolio's PRIMARY source (useV2Positions); on 7-29 it is reconstructed from
 *  the order log by folding net-open per position (see lib/api/v2/onchain.ts). */
export const getAccountPositions = (accountId: string, owner?: string, o?: GetOptions) =>
  V2_IS_729_PLUS
    ? // Prefer the owner (tx-sender) read: whale-immune and complete. The account-id
      // scan only survives while the account isn't buried in the global stream, so
      // it's a fallback for the rare caller that has no owner to hand.
      owner
      ? onchainOwnerPositions(owner, o)
      : onchainAccountPositions(accountId, o)
    : beta<V2Position[]>(`/accounts/${accountId}/positions`, o);

/** The account's order EVENT log (mints + redeems) — the source for trade
 *  history, portfolio positions, and the leaderboard completeness fold. The
 *  server DEFAULTS to only 50 rows and hard-caps at 500 (verified live
 *  2026-07-18), so request the full 500 explicitly — the 50-row default was
 *  silently truncating active wallets' history. */
export const getAccountOrders = (accountId: string, owner?: string, limit = 500, o?: GetOptions) =>
  V2_IS_729_PLUS
    ? // Owner (tx-sender) read first — whale-immune. onchainAccountOrders (the
      // global-stream scan filtered by account_id) is only a fallback: under a
      // high-frequency bot it returns nothing once the account's events roll past
      // the scan window (verified live: owner path 5 events, account-id path 0).
      owner
      ? onchainOwnerOrders(owner, 300, o)
      : onchainAccountOrders(accountId, limit, o)
    : beta<V2OrderEvent[]>(`/accounts/${accountId}/orders?limit=${limit}`, o);

/** Vault NAV + latest flush — pool_value/total_supply give the live share price.
 *  On 7-29 both come from the newest on-chain FlushExecuted event. */
export const getVaultState = (vaultId: string, o?: GetOptions) =>
  V2_IS_729_PLUS
    ? onchainVaultState(o)
    : beta<V2VaultServerState>(`/vaults/${vaultId}/state`, o);

/** Keeper flush history (newest-first). Each flush marks the pool at that moment,
 *  so pool_value/total_supply per flush IS the share-price series over time — the
 *  v2 stand-in for legacy's `/vault/performance` (which v2 doesn't expose). On 7-29
 *  these are the `FlushExecuted` events (see lib/api/v2/onchain.ts). */
export const getVaultFlushes = (vaultId: string, limit = 200, o?: GetOptions) =>
  V2_IS_729_PLUS
    ? onchainVaultFlushes(limit, o)
    : beta<V2VaultFlush[]>(`/vaults/${vaultId}/flushes?limit=${limit}`, o);

/** Realized profit per market settlement (LP + protocol split), newest-first —
 *  drives the vault performance panel's cumulative LP-profit series. On 7-29 these
 *  are the `ExpiryProfitMaterialized` events. */
export const getVaultProfit = (vaultId: string, limit = 200, o?: GetOptions) =>
  V2_IS_729_PLUS
    ? onchainVaultProfit(limit, o)
    : beta<V2VaultProfit[]>(`/vaults/${vaultId}/profit?limit=${limit}`, o);

/** Hourly supply/withdraw activity buckets for the vault. No consumer wires this
 *  yet, and 7-29 has no bucketing indexer, so it degrades to empty there. */
export const getVaultFlows = (vaultId: string, limit = 200, o?: GetOptions) =>
  V2_IS_729_PLUS
    ? Promise.resolve([] as V2VaultFlow[])
    : beta<V2VaultFlow[]>(`/vaults/${vaultId}/flows?limit=${limit}`, o);

/** Executed LP deposits (escrowed DUSDC → PLP shares at NAV), newest-first. On
 *  7-29 these are the `SupplyFilled` events. */
export const getVaultSupplyFills = (vaultId: string, limit = 30, o?: GetOptions) =>
  V2_IS_729_PLUS
    ? onchainVaultSupplyFills(limit, o)
    : beta<V2VaultSupplyFill[]>(`/vaults/${vaultId}/supply-fills?limit=${limit}`, o);

/** Executed LP withdrawals (PLP shares → DUSDC at NAV), newest-first. On 7-29
 *  these are the `WithdrawFilled` events. */
export const getVaultWithdrawFills = (vaultId: string, limit = 30, o?: GetOptions) =>
  V2_IS_729_PLUS
    ? onchainVaultWithdrawFills(limit, o)
    : beta<V2VaultWithdrawFill[]>(`/vaults/${vaultId}/withdraw-fills?limit=${limit}`, o);

/** Builder-fee CLAIM history for a code — sum of `amount` = lifetime swept. On 7-29/8-06
 *  reconstructed from the on-chain `builder_code_events::BuilderFeesClaimed` stream (only
 *  the owner can claim, so it's a tiny, whale-proof feed); 6-24 used the beta indexer. */
export const getBuilderCodeFees = (codeId: string, limit = 200, o?: GetOptions) =>
  V2_IS_729_PLUS
    ? onchainBuilderCodeFees(codeId, limit, o)
    : beta<V2BuilderFee[]>(`/builder-codes/${codeId}/fees?limit=${limit}`, o);

/** Authoritative per-position cost/payout roll-up. `null` while still open, so
 *  callers keep the client-side order derivation as the fallback. On 7-29 there is
 *  no server aggregate, so it always returns null and the order derivation stands. */
export const getPositionCashflow = (marketId: string, positionRootId: string, o?: GetOptions) =>
  V2_IS_729_PLUS
    ? Promise.resolve(null as V2PositionCashflow | null)
    : beta<V2PositionCashflow | null>(`/markets/${marketId}/positions/${positionRootId}/cashflow`, o);

/** Open positions + max payout at risk for one market. On 7-29 folded from the
 *  market's order log (net-open per position). */
export const getMarketOpenInterest = (marketId: string, o?: GetOptions) =>
  V2_IS_729_PLUS
    ? onchainMarketOpenInterest(marketId, o)
    : beta<V2OpenInterest>(`/markets/${marketId}/open-interest`, o);

/** The market's order EVENT log (mints + redeems), newest-first — the per-market
 *  flow feed. There is no GLOBAL orders endpoint, so the analytics aggregate fans
 *  this out across the active markets to reconstruct the whole book's flow. On 7-29
 *  these come from the chain's order-event index. */
export const getMarketOrders = (marketId: string, limit = 60, o?: GetOptions) =>
  V2_IS_729_PLUS
    ? onchainMarketOrders(marketId, limit, o)
    : beta<V2OrderEvent[]>(`/markets/${marketId}/orders?limit=${limit}`, o);

/** The GLOBAL order-event stream (all markets + all accounts), newest-first — the
 *  drop-in for legacy's global mint/redeem feeds that the leaderboard folds by
 *  owner. 7-29 serves the whole stream from the chain's event index in ONE paged
 *  scan; 6-24 has no global endpoint (the board fans /markets/:id/orders out there
 *  instead), so this returns [] and useV2Leaderboard keeps its 6-24 fan-out path. */
export const getV2AllOrders = (perType = 800, o?: GetOptions): Promise<V2OrderEvent[]> =>
  V2_IS_729_PLUS
    ? onchainAllOrders(perType, o)
    : Promise.resolve([] as V2OrderEvent[]);

/** Hourly mint/redeem activity buckets for one market. No consumer wires this, and
 *  7-29 has no bucketing indexer, so it degrades to empty there. */
export const getMarketActivity = (marketId: string, limit = 50, o?: GetOptions) =>
  V2_IS_729_PLUS
    ? Promise.resolve([] as V2ActivityBucket[])
    : beta<V2ActivityBucket[]>(`/markets/${marketId}/activity?limit=${limit}`, o);

/** Hourly liquidation buckets for one market. No consumer wires this, and 7-29 has
 *  no bucketing indexer, so it degrades to empty there. */
export const getMarketLiquidationStats = (marketId: string, limit = 50, o?: GetOptions) =>
  V2_IS_729_PLUS
    ? Promise.resolve([] as V2LiquidationBucket[])
    : beta<V2LiquidationBucket[]>(`/markets/${marketId}/liquidation-stats?limit=${limit}`, o);

/* --------------------------- propbook indexer ---------------------------- */

export const getPropbookStatus = (o?: GetOptions): Promise<V2Status> =>
  V2_IS_729_PLUS ? Promise.resolve(synthStatus()) : propbook<V2Status>('/status', o);

/** Underlying → feed-object bindings. No consumer wires this, and on 7-29 the
 *  bindings are the fixed config feeds (asset.pythFeedId + bsFeedIds), so it
 *  degrades to empty rather than reconstructing the propbook binding table. */
export const getOracleBindings = (o?: GetOptions) =>
  V2_IS_729_PLUS
    ? Promise.resolve([] as OracleBinding[])
    : propbook<OracleBinding[]>('/oracle-bindings', o);

/** Latest raw Pyth spot observation for the underlying's pyth feed object id. On
 *  7-29 this is read LIVE off the PythFeed object (fresh to the second), not the
 *  ~20s-lagging event index. */
export const getPythLatest = (pythOracleId: string, o?: GetOptions): Promise<PythObservation | null> =>
  V2_IS_729_PLUS
    ? onchainPythLatest(o)
    : propbook<PythObservation | null>(`/oracles/${pythOracleId}/pyth/latest`, o);

/** Recent Pyth spot observation history (for the price chart). */
export const getPythHistory = (pythOracleId: string, limit = 300, o?: GetOptions) =>
  V2_IS_729_PLUS
    ? onchainPythObservations(limit, o)
    : propbook<PythObservation[]>(`/oracles/${pythOracleId}/pyth?limit=${limit}`, o);

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
  vaultFills: (id: string) => ['v2', 'vault', id, 'fills'] as const,
  builderCodeFees: (id: string) => ['v2', 'builder-code', id, 'fees'] as const,
  positionCashflow: (marketId: string, root: string) =>
    ['v2', 'market', marketId, 'position', root, 'cashflow'] as const,
  marketOpenInterest: (id: string) => ['v2', 'market', id, 'open-interest'] as const,
  marketActivity: (id: string) => ['v2', 'market', id, 'activity'] as const,
  marketOrders: (id: string) => ['v2', 'market', id, 'orders'] as const,
};
