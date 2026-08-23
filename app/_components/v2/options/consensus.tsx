'use client';

/**
 * ProbabilityConsensus — the page's flagship visual. Three independent, horizon-
 * matched reads of the SELECTED bet (our surface · a recent-vol model · how often it
 * actually happened) plotted on one 0–100% scale, with the shaded band showing where
 * they agree. When they cluster the bet is priced right; when they split, that gap is
 * the read. Every number is real (the engine's `buildConsensus`) — no crowd market is
 * mixed in, because Polymarket's BTC markets are longer-dated than ours.
 */
import { num, timeLeftWords } from '@/lib/format';
import { useNow } from '@/lib/hooks/use-now';
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
  expiryMs,
  onBet,
}: {
  consensus: Consensus | null;
  strikePrice: number | null;
  isUp: boolean;
  /** The selected market's expiry (ms). The countdown ticks off a live 1s clock
   *  here, not the parent's Pyth-driven `now`, so seconds read smoothly instead of
   *  jumping when a price tick arrives. */
  expiryMs: number | null;
  onBet: () => void;
}) {
  const { mode, pro } = useVocab();
  // Live 1s wall-clock (shared interval) so the "by 45 sec" horizon ticks down
  // smoothly. Called before the early return to keep hook order stable. Seed 0 is
  // never shown (this card only renders client-side, once consensus data loads).
  const now = useNow(0);
  if (!consensus || strikePrice == null) return null;

  const timeLabel = expiryMs != null ? timeLeftWords(expiryMs - now) : '';

  const bandLeft = consensus.low * 100;
  const bandWidth = Math.max(0.5, (consensus.high - consensus.low) * 100);

  return (
    <section>
      <div className="mb-3 mt-1 flex items-center gap-2.5">
        <h2 className="text-[14px] font-semibold text-text-1">{pro ? 'Probability consensus' : 'Is this bet priced right?'}</h2>
        {pro && (
          <span className="rounded bg-(--accent-soft) px-2 py-0.5 text-[10px] uppercase tracking-wide text-accent ring-1 ring-inset ring-(--accent-line)">flagship</span>
        )}
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

        {/* PLAIN reads the three sources as ONE answer. The three-bar chart with an
            agreement band is a real read for a desk, but to a newcomer it is three
            near-identical bars and a dashed line that needs explaining — and the panel
            already computes the sentence that says what it means. So Plain gets that
            sentence plus a single bar (our surface, the number the bet is priced off),
            and Pro keeps the full comparison. */}
        {!pro && (
          <div className="mt-4">
            <div className="flex items-center gap-3">
              <span className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-white/5 shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)] ring-1 ring-inset ring-white/5">
                <span
                  className="absolute inset-y-0 left-0 overflow-hidden rounded-full"
                  style={{ width: `${(consensus.sources[0]?.prob ?? 0) * 100}%`, background: SRC_COLOR.surface, opacity: 0.85 }}
                >
                  <span className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-linear-to-b from-white/30 to-transparent" />
                </span>
              </span>
              <span className="w-12 text-right font-mono text-[15px] tabular-nums text-text-1">
                {Math.round((consensus.sources[0]?.prob ?? 0) * 100)}%
              </span>
            </div>
          </div>
        )}

        <div className={`relative mb-1 mt-6 ${pro ? '' : 'hidden'}`}>
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
              {/* Frosted glass meter: a concave translucent track (inset shadow +
                  hairline) with a filled bar that carries a top-light sheen, so the
                  reads read as lit glass rather than flat swatches. */}
              <span className="relative h-2 overflow-hidden rounded-full bg-white/5 shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)] ring-1 ring-inset ring-white/5">
                <span
                  className="absolute inset-y-0 left-0 overflow-hidden rounded-full"
                  style={{ width: `${s.prob * 100}%`, background: SRC_COLOR[s.key], opacity: 0.85 }}
                >
                  <span className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-linear-to-b from-white/30 to-transparent" />
                </span>
              </span>
              <span className="text-right font-mono text-[13px] tabular-nums text-text-1">{Math.round(s.prob * 100)}%</span>
            </div>
          ))}
        </div>

        <div className="glass-divider-top mt-3 flex flex-wrap items-center justify-between gap-3 pt-3">
          <p className="min-w-[240px] flex-1 text-[12.5px] leading-relaxed text-text-1">{consensus.synthesis}</p>
          <div className="flex items-center gap-2.5">
            <span
              className={`${pro ? 'inline-flex' : 'hidden'} items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[11px] ring-1 ring-inset ${
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
