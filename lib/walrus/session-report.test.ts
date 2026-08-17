import { describe, it, expect } from 'vitest';
import { Ed25519Keypair, Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { fromBase64 } from '@mysten/sui/utils';
import { reportBytes, type SessionReportCore } from './session-report';

const core: SessionReportCore = {
  version: 1,
  author: 'kelly-autopilot',
  createdAt: 123,
  run: {
    id: 'r1', armedAt: 1000, endedAt: 5000, mode: 'live', stopReason: 'manual',
    budgetUsd: 25, perTradeUsd: 5, tradeCount: 1, wins: 1, losses: 0, pendingCount: 0, realizedPnlUsd: 4,
  },
  config: {
    minEdge: 0, minProb: 0.6, maxLeverage: 2, tenors: ['hour'], sides: ['up'],
    maxTrades: 10, maxConcurrent: 2, cooldownMs: 60_000, maxConsecutiveLosses: 3, armDurationMs: 3_600_000,
  },
  trades: [{ marketId: '0xm1', side: 'up', strike: 60_000, stake: 5, entryProb: 0.62, outcome: 'won', pnlUsd: 4, at: 1500, digest: '0xabc' }],
  decisions: [{ at: 1500, kind: 'placed', text: 'Placed', marketId: '0xm1', digest: '0xabc' }],
};

describe('reportBytes', () => {
  it('is deterministic regardless of key order (so sign == verify)', () => {
    // Same data, keys in a different order — the canonical bytes must match.
    const reordered = {
      trades: core.trades, decisions: core.decisions, config: core.config, run: core.run,
      createdAt: core.createdAt, author: core.author, version: core.version,
    } as SessionReportCore;
    expect(reportBytes(reordered)).toEqual(reportBytes(core));
  });
});

describe('session report signature', () => {
  it('a signature over reportBytes verifies, and any tamper breaks it', async () => {
    const kp = Ed25519Keypair.generate();
    const sig = await kp.sign(reportBytes(core));
    const pub = new Ed25519PublicKey(fromBase64(kp.getPublicKey().toBase64()));
    expect(await pub.verify(reportBytes(core), sig)).toBe(true);
    // Change one number in the run → the signature no longer matches.
    const tampered = { ...core, run: { ...core.run, realizedPnlUsd: 999 } };
    expect(await pub.verify(reportBytes(tampered), sig)).toBe(false);
  });
});
