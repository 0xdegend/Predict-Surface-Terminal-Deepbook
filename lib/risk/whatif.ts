/**
 * lib/risk/whatif.ts — ±Nσ PLP risk simulator (§8.4), pure + testable.
 *
 * The vault is SHORT every outstanding binary. We reconstruct net open interest
 * (minted − redeemed) per (oracle, strike, side) for the active oracles, value
 * the vault's liability off the live SVI surface, then shock spot by ±Nσ and
 * reprice — answering "is PLP safe?".
 *
 * The shock shifts the forward (F' = F·(1+r)); SVI params are held fixed (an
 * instantaneous spot move). Liability is in DUSDC base units (6dec), comparable
 * to the reported total_mtm, so we can calibrate the model against the chain.
 */
import { upFair, impliedVol, timeToExpiryYears, type SviFloat } from '@/lib/svi/svi';
import { toFloat } from '@/config/scale';
import type { SmileInput } from '@/lib/svi/surface';
import type { PositionMintedEvent, PositionRedeemedEvent } from '@/lib/api/types';

export interface OpenInterest {
  oracleId: string;
  strike: number; // float
  isUp: boolean;
  netQty: number; // DUSDC base units (max payout), >= 0 kept
}

/** Net open interest per (oracle, strike, side) for the given active oracles. */
export function reconstructOpenInterest(
  minted: PositionMintedEvent[],
  redeemed: PositionRedeemedEvent[],
  activeOracleIds: Set<string>,
): OpenInterest[] {
  const acc = new Map<string, OpenInterest>();
  const key = (o: string, s: number, up: boolean) => `${o}:${s}:${up ? 1 : 0}`;

  for (const m of minted) {
    if (!activeOracleIds.has(m.oracle_id)) continue;
    const k = key(m.oracle_id, m.strike, m.is_up);
    const e = acc.get(k) ?? { oracleId: m.oracle_id, strike: toFloat(m.strike), isUp: m.is_up, netQty: 0 };
    e.netQty += m.quantity;
    acc.set(k, e);
  }
  for (const r of redeemed) {
    if (!activeOracleIds.has(r.oracle_id)) continue;
    const k = key(r.oracle_id, r.strike, r.is_up);
    const e = acc.get(k);
    if (e) e.netQty -= r.quantity;
  }
  return [...acc.values()].filter((e) => e.netQty > 0);
}

interface OracleParams {
  svi: SviFloat;
  forward: number;
  settlement: number | null;
}

function paramsByOracle(inputs: SmileInput[]): Map<string, OracleParams> {
  const m = new Map<string, OracleParams>();
  for (const i of inputs) {
    m.set(i.oracle.oracle_id, { svi: i.svi, forward: i.forward, settlement: i.settlement ?? null });
  }
  return m;
}

/**
 * Vault liability (DUSDC base units) under a proportional spot shock `r`
 * (r = 0 → current). Each short position's liability = netQty · fairValue(side).
 */
export function vaultLiability(
  oi: OpenInterest[],
  inputs: SmileInput[],
  shockReturn: number,
): number {
  const params = paramsByOracle(inputs);
  let liab = 0;
  for (const e of oi) {
    const p = params.get(e.oracleId);
    if (!p) continue;
    const forward = p.forward * (1 + shockReturn);
    const up = upFair(e.strike, forward, p.svi, p.settlement);
    const fair = e.isUp ? up : 1 - up;
    liab += e.netQty * fair;
  }
  return liab;
}

/**
 * σ unit for the shock = ATM implied vol × √T of the SHORTEST-dated active
 * oracle (the most immediate risk horizon). Returns a proportional return.
 */
export function sigmaUnit(inputs: SmileInput[], nowMs: number = Date.now()): number {
  let best: { t: number; sig: number } | null = null;
  for (const i of inputs) {
    const t = timeToExpiryYears(i.oracle.expiry, nowMs);
    if (t <= 0) continue;
    const iv = impliedVol(i.forward, i.forward, i.svi, t);
    const sig = iv * Math.sqrt(t);
    if (!best || t < best.t) best = { t, sig };
  }
  return best?.sig ?? 0.01;
}

export interface ScenarioPoint {
  nSigma: number;
  shockPct: number; // proportional spot move
  deltaValue: number; // change in vault value (base units, signed)
  vaultValue: number; // projected (base units)
  sharePrice: number;
  pnlPct: number; // PLP P&L as fraction of current vault value
}

export interface WhatIf {
  baseLiability: number; // modeled liability at shock 0 (base units)
  reportedMtm: number; // chain total_mtm (calibration reference)
  sigma: number; // σ unit (proportional)
  points: ScenarioPoint[];
  worstPnlPct: number; // most negative pnl across the swept range
}

/** Sweep ±maxSigma and project PLP impact. */
export function buildWhatIf(args: {
  oi: OpenInterest[];
  inputs: SmileInput[];
  vaultValue: number; // reported, base units
  totalShares: number; // PLP supply, base units
  reportedMtm: number;
  maxSigma?: number;
  steps?: number;
  nowMs?: number;
  /** Demo-only exposure amplifier (default 1 = strictly live). Scales each
   *  position's net open interest so the stress impact is visible on thin
   *  testnet books. Liability is linear in netQty, so this scales the modeled
   *  drawdown by the same factor — callers must label any value > 1 as amplified. */
  stressMultiplier?: number;
}): WhatIf {
  const { inputs, vaultValue, totalShares, reportedMtm } = args;
  const maxSigma = args.maxSigma ?? 3;
  const steps = args.steps ?? 25;
  const mult = args.stressMultiplier ?? 1;
  // Scale open interest for the demo amplifier; ×1 leaves the live book untouched.
  const oi = mult === 1 ? args.oi : args.oi.map((e) => ({ ...e, netQty: e.netQty * mult }));
  const sigma = sigmaUnit(inputs, args.nowMs);
  const baseLiability = vaultLiability(oi, inputs, 0);

  const points: ScenarioPoint[] = [];
  let worstPnlPct = 0;
  for (let i = 0; i < steps; i++) {
    const nSigma = -maxSigma + (2 * maxSigma * i) / (steps - 1);
    const shockPct = nSigma * sigma;
    const liab = vaultLiability(oi, inputs, shockPct);
    // Vault loses value when its short liability grows.
    const deltaValue = -(liab - baseLiability);
    const projValue = vaultValue + deltaValue;
    const sharePrice = totalShares > 0 ? projValue / totalShares : 0;
    const pnlPct = vaultValue > 0 ? deltaValue / vaultValue : 0;
    worstPnlPct = Math.min(worstPnlPct, pnlPct);
    points.push({ nSigma, shockPct, deltaValue, vaultValue: projValue, sharePrice, pnlPct });
  }

  return { baseLiability, reportedMtm, sigma, points, worstPnlPct };
}
