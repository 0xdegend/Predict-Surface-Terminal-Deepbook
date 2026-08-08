import { describe, it, expect, beforeEach } from 'vitest';
import { mergePythTape, getPythTape, pythTapeSize, _resetPythTape } from './pyth-tape';
import type { PythObservation } from '@/lib/api/v2/types';

/** Minimal observation at `sec` (unix seconds) with spot `price` ($, whole dollars). */
function obs(sec: number, price: number): PythObservation {
  return {
    propbook_oracle_id: '0',
    pyth_source_id: 0,
    price_magnitude: String(price),
    price_is_negative: false,
    exponent_magnitude: 0,
    exponent_is_negative: false,
    source_timestamp_ms: sec * 1000,
    checkpoint_timestamp_ms: sec * 1000,
  };
}

const spotOf = (o: PythObservation) => Number(o.price_magnitude);

describe('pyth-tape rolling buffer', () => {
  beforeEach(() => _resetPythTape());

  it('dedupes per second — the last write in a second wins', () => {
    mergePythTape(obs(1000, 64_990));
    mergePythTape(obs(1000, 64_998)); // same second, newer value
    expect(pythTapeSize()).toBe(1);
    expect(spotOf(getPythTape()[0])).toBe(64_998);
  });

  it('keeps distinct seconds and returns them ascending', () => {
    mergePythTape([obs(1002, 3), obs(1000, 1), obs(1001, 2)]);
    expect(getPythTape().map(spotOf)).toEqual([1, 2, 3]);
  });

  it('prunes points older than the ~150s window relative to the newest', () => {
    mergePythTape(obs(1_000, 100)); // will fall outside the window
    mergePythTape(obs(1_100, 200)); // 100s newer — still inside
    mergePythTape(obs(1_200, 300)); // now 1_000 is 200s old → pruned
    const secs = getPythTape().map(spotOf);
    expect(secs).toEqual([200, 300]);
  });

  it('ignores observations with no usable timestamp', () => {
    const bad = { ...obs(1000, 1), source_timestamp_ms: null, checkpoint_timestamp_ms: null } as unknown as PythObservation;
    mergePythTape(bad);
    expect(pythTapeSize()).toBe(0);
  });

  it('is a no-op on empty / nullish input', () => {
    mergePythTape(null);
    mergePythTape([]);
    expect(pythTapeSize()).toBe(0);
  });
});
