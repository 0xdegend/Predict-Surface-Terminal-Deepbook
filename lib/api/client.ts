/**
 * lib/api/client.ts — typed fetch wrapper + endpoint functions for the Predict server.
 *
 * Pure functions (no React) so they're usable from Server Components, TanStack
 * queryFns, and scripts alike. Base URL comes from config/predict.ts.
 */
import { predictConfig } from '@/config/predict';
import type {
  StatusResponse,
  PredictState,
  Oracle,
  OracleStateResponse,
  SviEvent,
  PriceEvent,
  VaultSummary,
  AskBounds,
  ManagerRow,
  ManagerSummary,
  PositionSummary,
  ManagerPnl,
  VaultPerformance,
  PositionMintedEvent,
  PositionRedeemedEvent,
} from './types';

export class PredictApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'PredictApiError';
  }
}

interface GetOptions {
  /** Next.js fetch cache control. Default: no-store for live data. */
  revalidate?: number | false;
  signal?: AbortSignal;
}

async function get<T>(path: string, opts: GetOptions = {}): Promise<T> {
  const url = `${predictConfig.serverUrl}${path}`;
  const cache: RequestCache | undefined =
    opts.revalidate === undefined ? 'no-store' : undefined;
  const next =
    opts.revalidate !== undefined && opts.revalidate !== false
      ? { revalidate: opts.revalidate }
      : undefined;

  const res = await fetch(url, { cache, next, signal: opts.signal });
  if (!res.ok) {
    throw new PredictApiError(`GET ${path} → ${res.status}`, res.status, url);
  }
  return (await res.json()) as T;
}

const PID = () => predictConfig.predictObjectId;

/* ------------------------- protocol & markets ------------------------- */

export const getStatus = (o?: GetOptions) => get<StatusResponse>('/status', o);

export const getPredictState = (o?: GetOptions) =>
  get<PredictState>(`/predicts/${PID()}/state`, o);

export const getOracles = (o?: GetOptions) =>
  get<Oracle[]>(`/predicts/${PID()}/oracles`, o);

export const getQuoteAssets = (o?: GetOptions) =>
  get<string[]>(`/predicts/${PID()}/quote-assets`, o);

export const getOracleState = (oracleId: string, o?: GetOptions) =>
  get<OracleStateResponse>(`/oracles/${oracleId}/state`, o);

export const getAskBounds = (oracleId: string, o?: GetOptions) =>
  get<AskBounds | null>(`/oracles/${oracleId}/ask-bounds`, o);

/* ----------------------------- oracle tape ---------------------------- */

export const getLatestSvi = (oracleId: string, o?: GetOptions) =>
  get<SviEvent>(`/oracles/${oracleId}/svi/latest`, o);

export const getLatestPrices = (oracleId: string, o?: GetOptions) =>
  get<PriceEvent>(`/oracles/${oracleId}/prices/latest`, o);

/** SVI history (drives the time-travel scrub). Newest-first from the server. */
export const getSviHistory = (oracleId: string, limit?: number, o?: GetOptions) =>
  get<SviEvent[]>(`/oracles/${oracleId}/svi${limit ? `?limit=${limit}` : ''}`, o);

export const getPriceHistory = (oracleId: string, limit?: number, o?: GetOptions) =>
  get<PriceEvent[]>(`/oracles/${oracleId}/prices${limit ? `?limit=${limit}` : ''}`, o);

/* ---------------------------- managers/portfolio ---------------------- */

export const getManagersByOwner = (owner: string, o?: GetOptions) =>
  get<ManagerRow[]>(`/managers?owner=${owner}`, o);

/** All managers (no owner filter) — powers the leaderboard owner→managers map. */
export const getManagers = (limit = 5000, o?: GetOptions) =>
  get<ManagerRow[]>(`/managers?limit=${limit}`, o);

export const getManagerSummary = (managerId: string, o?: GetOptions) =>
  get<ManagerSummary>(`/managers/${managerId}/summary`, o);

export const getManagerPositions = (managerId: string, o?: GetOptions) =>
  get<PositionSummary[]>(`/managers/${managerId}/positions/summary`, o);

export const getManagerPnl = (managerId: string, range = 'ALL', o?: GetOptions) =>
  get<ManagerPnl>(`/managers/${managerId}/pnl?range=${range}`, o);

/* -------------------------------- vault ------------------------------- */

export const getVaultSummary = (o?: GetOptions) =>
  get<VaultSummary>(`/predicts/${PID()}/vault/summary`, o);

export const getVaultPerformance = (range = 'ALL', o?: GetOptions) =>
  get<VaultPerformance>(`/predicts/${PID()}/vault/performance?range=${range}`, o);

/* ---------------------- global position events ------------------------ */

export const getPositionsMinted = (limit = 500, o?: GetOptions) =>
  get<PositionMintedEvent[]>(`/positions/minted?limit=${limit}`, o);

export const getPositionsRedeemed = (limit = 500, o?: GetOptions) =>
  get<PositionRedeemedEvent[]>(`/positions/redeemed?limit=${limit}`, o);

/* ------------------------- TanStack query keys ------------------------ */

export const qk = {
  status: ['status'] as const,
  predictState: ['predict', 'state'] as const,
  oracles: ['oracles'] as const,
  oracleState: (id: string) => ['oracle', id, 'state'] as const,
  latestSvi: (id: string) => ['oracle', id, 'svi', 'latest'] as const,
  latestPrices: (id: string) => ['oracle', id, 'prices', 'latest'] as const,
  sviHistory: (id: string) => ['oracle', id, 'svi', 'history'] as const,
  vaultSummary: ['vault', 'summary'] as const,
  managers: (owner: string) => ['managers', owner] as const,
  managerSummary: (id: string) => ['manager', id, 'summary'] as const,
  managerPositions: (id: string) => ['manager', id, 'positions'] as const,
  managerPnl: (id: string) => ['manager', id, 'pnl'] as const,
  dusdcBalance: (owner: string) => ['balance', owner, 'dusdc'] as const,
  vaultPerformance: (range: string) => ['vault', 'performance', range] as const,
  openInterest: ['open-interest'] as const,
  predictConfig: ['predict', 'config'] as const,
  leaderboardBase: ['leaderboard', 'base'] as const,
  leaderboardPnl: (ids: string) => ['leaderboard', 'pnl', ids] as const,
};
