import { describe, it, expect } from 'vitest';
import {
  POS_INF_TICK,
  strikeToTick,
  tickToStrike,
  admissionMultiple,
  snapStrikeToAdmission,
  isAdmissibleTick,
  binaryTicks,
  rangeTicks,
  leverageScaled,
  maxCostWithSlippage,
  maxProbabilityWithSlippage,
} from './ticks';

const TICK = 10_000_000n; // $0.01 (1e9-scaled)
const ADM = 1_000_000_000n; // $1 (1e9-scaled)
const S = (dollars: number) => BigInt(dollars) * 1_000_000_000n; // $ → 1e9-scaled

describe('strike ⇄ tick', () => {
  it('price = tick × tick_size, round-trips on the admission grid', () => {
    expect(strikeToTick(S(60398), TICK)).toBe(6_039_800n);
    expect(tickToStrike(6_039_800n, TICK)).toBe(S(60398));
  });
  it('admission multiple is admission_tick_size / tick_size', () => {
    expect(admissionMultiple(TICK, ADM)).toBe(100n);
  });
  it('snaps strikes to the $1 admission grid', () => {
    expect(snapStrikeToAdmission(60398_400_000_000n, ADM)).toBe(S(60398));
    expect(snapStrikeToAdmission(60398_600_000_000n, ADM)).toBe(S(60399));
  });
  it('admissibility: aligned ticks and sentinels pass, off-grid fails', () => {
    const m = admissionMultiple(TICK, ADM);
    expect(isAdmissibleTick(6_039_800n, m)).toBe(true); // 60398 → tick %100==0
    expect(isAdmissibleTick(6_039_850n, m)).toBe(false); // $60398.50 off the $1 grid
    expect(isAdmissibleTick(POS_INF_TICK, m)).toBe(true);
    expect(isAdmissibleTick(0n, m)).toBe(true);
  });
});

describe('binaryTicks (UP/DOWN as ranges)', () => {
  it('UP = (strikeTick, +∞)', () => {
    expect(binaryTicks(S(60398), true, TICK)).toEqual({ lowerTick: 6_039_800n, higherTick: POS_INF_TICK });
  });
  it('DOWN = (−∞, strikeTick)', () => {
    expect(binaryTicks(S(60398), false, TICK)).toEqual({ lowerTick: 0n, higherTick: 6_039_800n });
  });
  it('keeps lower < higher both directions', () => {
    const up = binaryTicks(S(60398), true, TICK);
    const dn = binaryTicks(S(60398), false, TICK);
    expect(up.lowerTick < up.higherTick).toBe(true);
    expect(dn.lowerTick < dn.higherTick).toBe(true);
  });
});

describe('rangeTicks', () => {
  it('maps both bounds through tick_size', () => {
    expect(rangeTicks(S(60000), S(61000), TICK)).toEqual({ lowerTick: 6_000_000n, higherTick: 6_100_000n });
  });
});

describe('leverage + slippage', () => {
  it('scales leverage to 1e9', () => {
    expect(leverageScaled(1)).toBe(1_000_000_000n);
    expect(leverageScaled(3)).toBe(3_000_000_000n);
  });
  it('max_cost adds slippage bps', () => {
    expect(maxCostWithSlippage(1_000_000n, 50)).toBe(1_005_000n); // +0.5%
    expect(maxCostWithSlippage(1_000_000n, 0)).toBe(1_000_000n);
  });
  it('max_probability adds slippage but clamps to market max', () => {
    expect(maxProbabilityWithSlippage(500_000_000n, 100, 990_000_000n)).toBe(505_000_000n);
    expect(maxProbabilityWithSlippage(985_000_000n, 200, 990_000_000n)).toBe(990_000_000n); // clamped
  });
});
