'use client';

import { quote as fmtQuote, price, pct, signed, dateUTC, countdown } from '@/lib/format';
import { toFloat } from '@/config/scale';
import { positionMetrics } from './position-metrics';
import type { PositionSummary } from '@/lib/api/types';

/**
 * A position told as a story, not a spec sheet: the verdict (WON / LOST / LIVE),
 * a probability track showing where you entered vs where the market is now (or
 * settled), and a dominant PnL with the action. The track is the signature —
 * a binary's price IS its probability, so entry→mark reads instantly.
 */
export function PositionCard({
  position,
  now,
  onRedeem,
  busy,
}: {
  position: PositionSummary;
  now: number;
  onRedeem: (p: PositionSummary) => void;
  busy: boolean;
}) {
  const p = position;
  const m = positionMetrics(p);
  const up = p.is_up;
  const expired = p.expiry - now <= 0;
  const decided = m.isSettled || expired;

  // A settled binary marks at 1 (won) or 0 (lost); fall back to PnL sign.
  const won = decided ? (m.markPrice ?? (m.pnl >= 0 ? 1 : 0)) >= 0.5 : null;
  const result: 'live' | 'won' | 'lost' = won === null ? 'live' : won ? 'won' : 'lost';
  const positive = m.pnl >= 0;

  return (
    <div
      className={`card interactive flex flex-col gap-4 p-4 pl-5 font-mono text-[12px] tabular-nums ${
        up ? 'accent-up' : 'accent-down'
      }`}
    >
      {/* header — the bet, in one glance */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                up ? 'bg-up/15 text-up' : 'bg-down/15 text-down'
              }`}
            >
              {up ? 'UP' : 'DOWN'}
            </span>
            <span className="text-[15px] text-text-1">{price(toFloat(p.strike))}</span>
          </div>
          <span className="font-sans text-[11px] text-text-3">
            {p.underlying_asset} settles {up ? 'above' : 'below'} · {dateUTC(p.expiry)} ·{' '}
            <span className={expired ? 'text-text-3' : 'text-text-2'}>
              {expired ? 'expired' : `${countdown(p.expiry, now)} left`}
            </span>
          </span>
        </div>
        <ResultChip result={result} />
      </div>

      {/* probability track — entry vs now/settled */}
      <ProbTrack entry={m.entryPrice} mark={m.markPrice} result={result} positive={positive} />

      {/* money line */}
      <div className="flex items-center justify-between text-[11px]">
        <Cell label="Contracts" value={fmtQuote(m.contracts)} />
        <Cell label="Cost" value={fmtQuote(m.cost)} />
        <Cell
          label={decided ? (won ? 'Payout' : 'Final') : 'Value'}
          value={m.value != null ? fmtQuote(m.value) : '—'}
          alignRight
        />
      </div>

      {/* hero PnL + action */}
      <div className="flex items-end justify-between border-t border-line-soft pt-3.5">
        <div className="flex flex-col gap-1">
          <span className="eyebrow">{decided ? 'Realized' : 'Unrealized'} PnL</span>
          <span className={`flex items-baseline gap-2 leading-none ${positive ? 'text-up' : 'text-down'}`}>
            <span className="text-[24px]">{signed(m.pnl)}</span>
            <span className="text-[12px] opacity-80">{signed(m.pnlPct * 100, 1)}%</span>
          </span>
        </div>
        <button
          onClick={() => onRedeem(p)}
          disabled={busy}
          className="rounded-md border border-line-strong px-3.5 py-2 text-[12px] text-text-1 transition-colors hover:border-up/40 hover:bg-up/5 hover:text-up disabled:opacity-50"
        >
          {m.isSettled ? 'Redeem' : 'Close'}
        </button>
      </div>
    </div>
  );
}

/** Binary price === probability, so a 0→100% track makes entry→mark legible. */
function ProbTrack({
  entry,
  mark,
  result,
  positive,
}: {
  entry: number;
  mark: number | null;
  result: 'live' | 'won' | 'lost';
  positive: boolean;
}) {
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  const e = clamp(entry);
  const mk = mark != null ? clamp(mark) : null;
  const lo = mk != null ? Math.min(e, mk) : e;
  const hi = mk != null ? Math.max(e, mk) : e;
  const fill =
    result === 'won' ? 'var(--up)' : result === 'lost' ? 'var(--down)' : positive ? 'var(--up)' : 'var(--down)';

  return (
    <div className="flex flex-col gap-2">
      <div className="relative h-1.5 rounded-full bg-bg-3">
        {mk != null && hi > lo && (
          <span
            className="absolute top-0 h-full rounded-full"
            style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%`, background: fill, opacity: 0.45 }}
          />
        )}
        {/* entry marker (hollow) */}
        <span
          className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-text-2 bg-bg-1"
          style={{ left: `${e * 100}%` }}
          title="entry"
        />
        {/* current / settled marker (filled) */}
        {mk != null && (
          <span
            className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ left: `${mk * 100}%`, background: fill }}
            title="now"
          />
        )}
      </div>
      <div className="flex justify-between text-[10px] text-text-3">
        <span>entry {pct(entry, 1)}</span>
        <span>
          {result === 'live' ? 'now' : 'settled'} {mk != null ? pct(mark!, 1) : '—'}
        </span>
      </div>
    </div>
  );
}

function Cell({ label, value, alignRight }: { label: string; value: string; alignRight?: boolean }) {
  return (
    <div className={`flex flex-col gap-0.5 ${alignRight ? 'items-end' : 'items-start'}`}>
      <span className="eyebrow">{label}</span>
      <span className="text-text-1">{value}</span>
    </div>
  );
}

function ResultChip({ result }: { result: 'live' | 'won' | 'lost' }) {
  if (result === 'live') {
    return (
      <span className="flex items-center gap-1.5 rounded-full border border-line bg-white/[0.03] px-2 py-0.5 text-[10px] uppercase tracking-wider text-text-2">
        <span className="live-dot scale-90" />
        Live
      </span>
    );
  }
  const won = result === 'won';
  return (
    <span
      className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
        won ? 'bg-[var(--accent-soft)] text-up' : 'bg-[var(--down-soft)] text-down'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${won ? 'bg-accent' : 'bg-down'}`} />
      {won ? 'Won' : 'Lost'}
    </span>
  );
}
