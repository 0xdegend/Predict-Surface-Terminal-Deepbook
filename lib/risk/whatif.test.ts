import { describe, it, expect } from 'vitest';
import { parseSvi } from '@/lib/svi/svi';
import type { SmileInput } from '@/lib/svi/surface';
import {
  reconstructOpenInterest,
  vaultLiability,
  sigmaUnit,
  buildWhatIf,
} from './whatif';
import type { Oracle, PositionMintedEvent, PositionRedeemedEvent, SviEvent } from '@/lib/api/types';

const RAW_SVI = {
  a: 61536, b: 1309541, rho: 940001720, rho_negative: true, m: 4991572, m_negative: true, sigma: 1072703,
} as unknown as SviEvent;
const FORWARD = 66935.67;

function oracle(id: string): Oracle {
  return {
    predict_id: '0xp', oracle_id: id, oracle_cap_id: '0xc', underlying_asset: 'BTC',
    expiry: Date.now() + 30 * 60_000, min_strike: 50_000 * 1e9, tick_size: 1e9,
    status: 'active', activated_at: Date.now(), settlement_price: null, settled_at: null, created_checkpoint: 0,
  };
}
const inputs: SmileInput[] = [{ oracle: oracle('0xA'), svi: parseSvi(RAW_SVI), forward: FORWARD, settlement: null }];

function minted(over: Partial<PositionMintedEvent>): PositionMintedEvent {
  return {
    event_digest: '', digest: '', sender: '', checkpoint: 0, checkpoint_timestamp_ms: 0, tx_index: 0,
    event_index: 0, package: '', oracle_id: '0xA', onchain_timestamp: 0, predict_id: '0xp', manager_id: '0xm',
    trader: '0xt', quote_asset: 'DUSDC', expiry: inputs[0].oracle.expiry, strike: 66000 * 1e9, is_up: true,
    quantity: 1_000_000, cost: 500_000, ask_price: 500_000_000, ...over,
  };
}
function redeemed(over: Partial<PositionRedeemedEvent>): PositionRedeemedEvent {
  return {
    event_digest: '', digest: '', sender: '', checkpoint: 0, checkpoint_timestamp_ms: 0, tx_index: 0,
    event_index: 0, package: '', oracle_id: '0xA', onchain_timestamp: 0, predict_id: '0xp', manager_id: '0xm',
    owner: '0xo', executor: '0xo', quote_asset: 'DUSDC', expiry: inputs[0].oracle.expiry, strike: 66000 * 1e9, is_up: true,
    quantity: 0, payout: 0, bid_price: 0, is_settled: false, ...over,
  };
}

describe('reconstructOpenInterest', () => {
  it('nets minted minus redeemed and filters inactive oracles', () => {
    const active = new Set(['0xA']);
    const oi = reconstructOpenInterest(
      [minted({ quantity: 3_000_000 }), minted({ oracle_id: '0xZ', quantity: 9_000_000 })],
      [redeemed({ quantity: 1_000_000 })],
      active,
    );
    expect(oi).toHaveLength(1);
    expect(oi[0].oracleId).toBe('0xA');
    expect(oi[0].netQty).toBe(2_000_000);
  });
  it('drops fully-redeemed (net <= 0) keys', () => {
    const oi = reconstructOpenInterest(
      [minted({ quantity: 1_000_000 })],
      [redeemed({ quantity: 1_000_000 })],
      new Set(['0xA']),
    );
    expect(oi).toHaveLength(0);
  });
});

describe('vaultLiability', () => {
  it('equals netQty × fair UP for a single UP short, and rises when spot rises', () => {
    const oi = [{ oracleId: '0xA', strike: 66000, isUp: true, netQty: 1_000_000 }];
    const base = vaultLiability(oi, inputs, 0);
    expect(base).toBeGreaterThan(0);
    expect(base).toBeLessThan(1_000_000); // fair < 1
    // Spot up → UP more likely → liability grows.
    expect(vaultLiability(oi, inputs, 0.02)).toBeGreaterThan(base);
    // Spot down → UP less likely → liability shrinks.
    expect(vaultLiability(oi, inputs, -0.02)).toBeLessThan(base);
  });
});

describe('buildWhatIf', () => {
  it('produces a swept curve, ~0 P&L at center, and a non-positive worst case', () => {
    const oi = [{ oracleId: '0xA', strike: 66000, isUp: true, netQty: 5_000_000 }];
    const wi = buildWhatIf({
      oi, inputs, vaultValue: 1_000_000_000_000, totalShares: 1_000_000_000_000,
      reportedMtm: 800_000, steps: 25, maxSigma: 3,
    });
    expect(wi.sigma).toBeGreaterThan(0);
    expect(wi.points).toHaveLength(25);
    const center = wi.points[Math.floor(25 / 2)];
    expect(Math.abs(center.pnlPct)).toBeLessThan(1e-9); // ~0 at no shock
    expect(wi.worstPnlPct).toBeLessThanOrEqual(0);
  });

  it('stressMultiplier scales the drawdown linearly and defaults to live (×1)', () => {
    const oi = [{ oracleId: '0xA', strike: 66000, isUp: true, netQty: 5_000_000 }];
    const common = {
      oi, inputs, vaultValue: 1_000_000_000_000, totalShares: 1_000_000_000_000,
      reportedMtm: 800_000, steps: 25, maxSigma: 3,
    } as const;
    const live = buildWhatIf(common);
    const amp = buildWhatIf({ ...common, stressMultiplier: 10 });
    // ×10 deepens the worst-case loss by ~10×; default matches an explicit ×1.
    expect(amp.worstPnlPct).toBeCloseTo(live.worstPnlPct * 10, 9);
    expect(buildWhatIf({ ...common, stressMultiplier: 1 }).worstPnlPct).toBeCloseTo(
      live.worstPnlPct,
      12,
    );
  });
});

describe('sigmaUnit', () => {
  it('is a small positive proportional move for short-dated oracles', () => {
    const s = sigmaUnit(inputs);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(0.1); // < 10% per sigma for a 30-min option
  });
});
