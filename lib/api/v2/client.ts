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

/** Owner-scoped open positions (verified 200; empty on testnet, shape best-effort). */
export const getAccountPositions = (owner: string, o?: GetOptions) =>
  beta<V2Position[]>(`/accounts/${owner}/positions`, o);

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
  accountPositions: (owner: string) => ['v2', 'account', owner, 'positions'] as const,
};
