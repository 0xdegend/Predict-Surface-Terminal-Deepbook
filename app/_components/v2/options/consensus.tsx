'use client';

/**
 * ProbabilityConsensus — the page's flagship visual. Three independent, horizon-
 * matched reads of the SELECTED bet (our surface · a recent-vol model · how often it
 * actually happened) plotted on one 0–100% scale, with the shaded band showing where
 * they agree. When they cluster the bet is priced right; when they split, that gap is
 * the read. Every number is real (the engine's `buildConsensus`) — no crowd market is
 * mixed in, because Polymarket's BTC markets are longer-dated than ours.
 */
import { num } from '@/lib/format';
import { useVocab } from './vocab';
import type { Consensus } from '@/lib/insights';

const SRC_COLOR: Record<string, string> = {
  surface: 'var(--accent)',
  recentVol: 'var(--text-2)',
  history: 'var(--text-1)',
};

export function ProbabilityConsensus({
  consensus,
  strikePrice,
  isUp,
  timeLabel,
  onBet,
}: {
  consensus: Consensus | null;
  strikePrice: number | null;
  isUp: boolean;
  timeLabel: string;
  onBet: () => void;
}) {
  const { mode } = useVocab();
  if (!consensus || strikePrice == null) return null;

  const bandLeft = consensus.low * 100;
  const bandWidth = Math.max(0.5, (consensus.high - consensus.low) * 100);

  return (
    <section>
      <div className="mb-3 mt-1 flex items-center gap-2.5">
        <h2 className="text-[14px] font-semibold text-text-1">Probability consensus</h2>
        <span className="rounded bg-(--accent-soft) px-2 py-0.5 text-[10px] uppercase tracking-wide text-accent ring-1 ring-inset ring-(--accent-line)">flagship</span>
        <span className="h-px flex-1 bg-gradient-to-r from-line to-transparent" />
      </div>

      <div className="glass rounded-lg p-4">
        <div className="font-mono text-[15px] text-text-1">
          Chance{' '}
          <b className="text-accent">
            BTC {isUp ? 'above' : 'below'} ${num(strikePrice, 0)}
          </b>{' '}
          by {timeLabel}
        </div>

        <div className="relative mb-1 mt-6">
          {/* Agreement zone — where the reads land. */}
          <div
            className="pointer-events-none absolute inset-y-0 rounded border-x border-dashed border-(--accent-line) bg-(--accent-soft)"
            style={{ left: `${bandLeft}%`, width: `${bandWidth}%` }}
          >
            <span className="absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap text-[9.5px] uppercase tracking-wide text-accent">agreement</span>
          </div>

          {consensus.sources.map((s) => (
            <div key={s.key} className="relative z-10 grid grid-cols-[140px_1fr_44px] items-center gap-3 py-1.5">
              <span className="flex items-center gap-2 text-[12px] text-text-2">
                <span className="h-2 w-2 flex-none rounded-sm" style={{ background: SRC_COLOR[s.key] }} />
                {mode === 'pro' ? s.label : s.plainLabel}
              </span>
              <span className="relative h-2 rounded bg-white/[0.045]">
                <span className="absolute inset-y-0 left-0 rounded" style={{ width: `${s.prob * 100}%`, background: SRC_COLOR[s.key], opacity: 0.82 }} />
              </span>
              <span className="text-right font-mono text-[13px] tabular-nums text-text-1">{Math.round(s.prob * 100)}%</span>
            </div>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
          <p className="min-w-[240px] flex-1 text-[12.5px] leading-relaxed text-text-1">{consensus.synthesis}</p>
          <div className="flex items-center gap-2.5">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[11px] ring-1 ring-inset ${
                consensus.agreement === 'tight' ? 'bg-(--accent-soft) text-accent ring-(--accent-line)' : 'bg-down/10 text-down ring-down/30'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${consensus.agreement === 'tight' ? 'bg-accent' : 'bg-down'}`} />
              {consensus.agreement === 'tight' ? 'tight' : 'split'} · {Math.round(consensus.spreadPts)} pts
            </span>
            <button
              type="button"
              onClick={onBet}
              className="rounded-md bg-(--accent-soft) px-3.5 py-1.5 text-[12px] font-medium text-accent ring-1 ring-inset ring-(--accent-line) transition hover:bg-accent/20"
            >
              Bet {isUp ? '↑' : '↓'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
