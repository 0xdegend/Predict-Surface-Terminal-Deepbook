'use client';

/**
 * ProbabilityLadder — the page's flagship. A column of mintable strikes around the
 * price, each with the surface's chance-above, the move it needs, how often that
 * has actually happened lately, the payout, and a one-click Bet. Clicking a row
 * lights that strike on the surface + pre-fills the ticket; Bet opens the ticket.
 *
 * Every rung is a real admission-snapped strike (lib/markets/v2-ladder) and the
 * chance-above is the engine's `upFair`, so nothing here can disagree with the
 * surface. The "happened lately" column is the engine's reality-check per strike.
 */
import { useMemo, type ReactNode } from 'react';
import { num, signed } from '@/lib/format';
import { buildLadder, type LadderRung } from '@/lib/markets/v2-ladder';
import { analyzeStrikeForMarket } from '@/lib/insights';
import { Term } from './vocab';
import { ShareXButton } from '../share/share-x-button';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

export function ProbabilityLadder({
  market,
  pricer,
  closes,
  now,
  onHighlight,
  onBet,
  onShareOdds,
}: {
  market: V2Market | null;
  pricer: LivePricer | null | undefined;
  closes: number[] | null | undefined;
  now: number;
  onHighlight: (strike: number, isUp: boolean) => void;
  onBet: (strike: number, isUp: boolean) => void;
  /** Share a rung's odds as a card (opens the share dialog in the screen). */
  onShareOdds?: (r: LadderRung) => void;
}) {
  const rungs = useMemo(
    () => (pricer ? buildLadder(pricer, market?.admission_tick_size ?? '1000000000') : []),
    [pricer, market?.admission_tick_size],
  );

  // Reality-check per rung — how often a move like this has actually landed lately.
  const hits = useMemo(() => {
    const m = new Map<number, number | null>();
    if (!pricer || !closes || !market) return m;
    for (const r of rungs) {
      const a = analyzeStrikeForMarket({ closes, pricer, strike: r.strike, isUp: true, expiryMs: market.expiry, now });
      m.set(r.strike, a?.empirical?.prob ?? null);
    }
    return m;
  }, [rungs, closes, pricer, market, now]);

  if (!market || !pricer || rungs.length === 0) {
    return <div className="glass rounded-lg p-8 text-center text-[13px] text-text-3">Building the probability ladder…</div>;
  }

  return (
    <div className="glass overflow-x-auto rounded-lg p-4">
      <table className="w-full min-w-[640px] border-collapse">
        <thead>
          <tr className="text-[10.5px] uppercase tracking-wide text-text-3">
            <Th className="text-left">Strike</Th>
            <Th><Term plain="Chance above" pro="P(above)" /></Th>
            <Th><Term plain="Move needed" pro="Δ to strike" /></Th>
            <Th><Term plain="Happened lately" pro="Realized hit-rate" /></Th>
            <Th><Term plain="Payout" pro="Payout ×" /></Th>
            <Th> </Th>
          </tr>
        </thead>
        <tbody>
          {rungs.map((r) => (
            <Row
              key={r.strike}
              r={r}
              hit={hits.get(r.strike) ?? null}
              onHighlight={() => onHighlight(r.strike, true)}
              onBet={() => onBet(r.strike, true)}
              onShare={onShareOdds ? () => onShareOdds(r) : undefined}
            />
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex flex-wrap justify-between gap-2 text-[11.5px] text-text-3">
        <span>
          <Term
            plain='"Happened lately" = how often recent moves actually cleared this in the same time window.'
            pro="Empirical terminal hit-rate over the recent 1-minute tape."
          />
        </span>
        <span>Settles on the price at expiry, not a touch.</span>
      </div>
    </div>
  );
}

function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <th className={`border-b border-line px-3.5 pb-2.5 text-right font-medium ${className}`}>{children}</th>;
}

function Row({
  r,
  hit,
  onHighlight,
  onBet,
  onShare,
}: {
  r: LadderRung;
  hit: number | null;
  onHighlight: () => void;
  onBet: () => void;
  onShare?: () => void;
}) {
  return (
    <tr
      onClick={onHighlight}
      className={`group cursor-pointer border-b border-line/60 font-mono text-[13px] transition hover:bg-white/2.5 ${r.isAtm ? 'bg-(--accent-soft)' : ''}`}
    >
      <td className={`px-3.5 py-2.5 text-left tabular-nums ${r.isAtm ? 'font-semibold text-accent' : 'text-text-1'}`}>
        ${num(r.strike, 0)}
        {r.isAtm && <span className="ml-2 rounded border border-(--accent-line) px-1.5 py-px font-sans text-[9.5px] tracking-wide text-accent">AT PRICE</span>}
      </td>
      <td className="px-3.5 py-2.5 text-right tabular-nums">
        <span className="inline-flex items-center justify-end gap-2">
          <span className="h-1.5 w-16 overflow-hidden rounded border border-line bg-bg-3">
            <span className="block h-full bg-accent/70" style={{ width: `${r.chanceAbove * 100}%` }} />
          </span>
          {(r.chanceAbove * 100).toFixed(0)}%
        </span>
      </td>
      <td className={`px-3.5 py-2.5 text-right tabular-nums ${r.movePct >= 0 ? 'text-up' : 'text-down'}`}>{signed(r.movePct, 2)}%</td>
      <td className="px-3.5 py-2.5 text-right tabular-nums text-text-2">{hit != null ? `${(hit * 100).toFixed(0)}%` : '—'}</td>
      <td className="px-3.5 py-2.5 text-right tabular-nums">{r.payoutUp.toFixed(2)}×</td>
      <td className="px-3.5 py-2.5 text-right">
        <span className="inline-flex items-center justify-end gap-1.5">
          {onShare && (
            <ShareXButton
              onClick={onShare}
              label="Share these odds"
              className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            />
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onBet();
            }}
            className="rounded-md bg-(--accent-soft) px-3 py-1 font-sans text-[12px] font-medium text-accent ring-1 ring-inset ring-(--accent-line) transition hover:bg-accent/20"
          >
            Bet ↑
          </button>
        </span>
      </td>
    </tr>
  );
}
