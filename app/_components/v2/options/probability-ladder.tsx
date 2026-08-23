'use client';

/**
 * ProbabilityLadder — the page's flagship. A column of mintable strikes around the
 * price, each one click from a bet. Clicking a row lights that strike on the surface +
 * pre-fills the ticket; Bet opens the ticket.
 *
 * TWO TABLES, ONE SOURCE. Plain shows the three things a first-timer needs to decide:
 * the strike, the chance, and what it pays. Pro adds the desk columns — the move
 * needed, implied vol, the recent hit-rate, the edge in probability points and the
 * expected value against it — and makes every column sortable, so the flagship table is
 * decision-grade on its own instead of sending a trader to the screener for the two
 * numbers that matter. Edge and EV use the SAME definitions as the scanner
 * (`empirical − implied`, `empirical / implied − 1`), so the two can never disagree.
 *
 * Every rung is a real admission-snapped strike (lib/markets/v2-ladder) and the
 * chance-above is the engine's `upFair`, so nothing here can disagree with the surface.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { num, signed } from '@/lib/format';
import { buildLadder, type LadderRung } from '@/lib/markets/v2-ladder';
import { analyzeStrikeForMarket } from '@/lib/insights';
import { impliedVol, timeToExpiryYears } from '@/lib/svi/svi';
import { Term, useVocab } from './vocab';
import { ShareXButton } from '../share/share-x-button';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

/** A rung plus the reads that only make sense with a tape and a clock behind them. */
interface LadderRow extends LadderRung {
  /** Recent terminal hit-rate for the up side (0..1), or null with no tape. */
  hit: number | null;
  /** This strike's implied vol (annualized fraction). */
  iv: number;
  /** empirical − implied, in probability points. Null without a hit-rate. */
  edgePts: number | null;
  /** Expected value per $1 at the fair price, as a %. Null without a hit-rate. */
  evPct: number | null;
}

type SortKey = 'strike' | 'chance' | 'iv' | 'hit' | 'edge' | 'ev' | 'payout';

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
  const { pro } = useVocab();
  // Strike ascending by default (chance runs high → low, top → bottom), which is how the
  // ladder reads against the surface. Sorting is a Pro affordance.
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'strike', desc: false });

  const rungs = useMemo(
    () => (pricer ? buildLadder(pricer, market?.admission_tick_size ?? '1000000000') : []),
    [pricer, market?.admission_tick_size],
  );

  // Per-rung reads: the recent hit-rate (the reality check), this strike's implied vol,
  // and the edge/EV that fall out of the two.
  const rows = useMemo<LadderRow[]>(() => {
    if (!pricer || !market) return [];
    const tYears = Math.max(timeToExpiryYears(market.expiry, now), 1e-9);
    return rungs.map((r) => {
      const a = closes
        ? analyzeStrikeForMarket({ closes, pricer, strike: r.strike, isUp: true, expiryMs: market.expiry, now })
        : null;
      const hit = a?.empirical?.prob ?? null;
      return {
        ...r,
        hit,
        iv: impliedVol(r.strike, pricer.forward, pricer.svi, tYears),
        edgePts: hit != null ? (hit - r.chanceAbove) * 100 : null,
        evPct: hit != null && r.chanceAbove > 0 ? (hit / r.chanceAbove - 1) * 100 : null,
      };
    });
  }, [rungs, closes, pricer, market, now]);

  const sorted = useMemo(() => {
    if (!pro) return rows;
    const val = (r: LadderRow): number => {
      switch (sort.key) {
        case 'chance':
          return r.chanceAbove;
        case 'iv':
          return r.iv;
        case 'hit':
          return r.hit ?? -1;
        case 'edge':
          return r.edgePts ?? -Infinity;
        case 'ev':
          return r.evPct ?? -Infinity;
        case 'payout':
          return r.payoutUp;
        default:
          return r.strike;
      }
    };
    return [...rows].sort((a, b) => (sort.desc ? val(b) - val(a) : val(a) - val(b)));
  }, [rows, sort, pro]);

  const toggle = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: true }));

  if (!market || !pricer || rows.length === 0) {
    return <div className="glass rounded-lg p-8 text-center text-[13px] text-text-3">Building the probability ladder…</div>;
  }

  return (
    <div className="glass overflow-x-auto rounded-lg p-4">
      <table className={`w-full border-collapse ${pro ? 'min-w-[860px]' : 'min-w-[420px]'}`}>
        <thead>
          <tr className="text-[10.5px] uppercase tracking-wide text-text-3">
            <SortTh k="strike" sort={sort} onClick={toggle} pro={pro} className="text-left">
              Strike
            </SortTh>
            <SortTh k="chance" sort={sort} onClick={toggle} pro={pro}>
              <Term plain="Chance above" pro="P(above)" />
            </SortTh>
            {pro && (
              <>
                <Th>Δ to strike</Th>
                <SortTh k="iv" sort={sort} onClick={toggle} pro={pro}>
                  IV
                </SortTh>
                <SortTh k="hit" sort={sort} onClick={toggle} pro={pro}>
                  Realized hit-rate
                </SortTh>
                <SortTh k="edge" sort={sort} onClick={toggle} pro={pro}>
                  Edge
                </SortTh>
                <SortTh k="ev" sort={sort} onClick={toggle} pro={pro}>
                  EV
                </SortTh>
              </>
            )}
            <SortTh k="payout" sort={sort} onClick={toggle} pro={pro}>
              <Term plain="Payout" pro="Payout ×" />
            </SortTh>
            <Th> </Th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <Row
              key={r.strike}
              r={r}
              pro={pro}
              onHighlight={() => onHighlight(r.strike, true)}
              onBet={() => onBet(r.strike, true)}
              onShare={onShareOdds ? () => onShareOdds(r) : undefined}
            />
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex flex-wrap justify-between gap-2 text-[11.5px] text-text-3">
        <span>
          {pro
            ? 'Edge = realized hit-rate − implied, in points. EV is against that same rate, at the fair price. Recent base rates, not forecasts.'
            : 'Payout is what $1 comes back as if you are right. Settles on the price at expiry, not a touch.'}
        </span>
        {pro && <span>Settles on the price at expiry, not a touch.</span>}
      </div>
    </div>
  );
}

function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <th className={`border-b border-line px-3.5 pb-2.5 text-right font-medium ${className}`}>{children}</th>;
}

/** A header cell that sorts in Pro and is plain text in Plain (nothing to sort when the
 *  table is three columns read top-to-bottom against the surface). */
function SortTh({
  k,
  sort,
  onClick,
  pro,
  children,
  className = '',
}: {
  k: SortKey;
  sort: { key: SortKey; desc: boolean };
  onClick: (k: SortKey) => void;
  pro: boolean;
  children: ReactNode;
  className?: string;
}) {
  if (!pro) return <Th className={className}>{children}</Th>;
  const on = sort.key === k;
  return (
    <th className={`border-b border-line px-3.5 pb-2.5 text-right font-medium ${className}`}>
      <button
        type="button"
        onClick={() => onClick(k)}
        aria-label={`Sort by ${k}`}
        className={`inline-flex items-center gap-1 transition-colors hover:text-text-1 ${on ? 'text-text-1' : ''}`}
      >
        {children}
        <span aria-hidden className={on ? 'text-accent' : 'text-text-3/50'}>
          {on ? (sort.desc ? '↓' : '↑') : '↕'}
        </span>
      </button>
    </th>
  );
}

function Row({
  r,
  pro,
  onHighlight,
  onBet,
  onShare,
}: {
  r: LadderRow;
  pro: boolean;
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
      {pro && (
        <>
          <td className={`px-3.5 py-2.5 text-right tabular-nums ${r.movePct >= 0 ? 'text-up' : 'text-down'}`}>{signed(r.movePct, 2)}%</td>
          <td className="px-3.5 py-2.5 text-right tabular-nums text-text-2">{(r.iv * 100).toFixed(1)}%</td>
          <td className="px-3.5 py-2.5 text-right tabular-nums text-text-2">{r.hit != null ? `${(r.hit * 100).toFixed(0)}%` : '—'}</td>
          <td
            className={`px-3.5 py-2.5 text-right tabular-nums ${
              r.edgePts == null ? 'text-text-3' : r.edgePts > 0 ? 'text-up' : 'text-text-2'
            }`}
          >
            {r.edgePts != null ? `${signed(r.edgePts, 1)}` : '—'}
          </td>
          <td
            className={`px-3.5 py-2.5 text-right tabular-nums ${r.evPct == null ? 'text-text-3' : r.evPct > 0 ? 'text-up' : 'text-down'}`}
          >
            {r.evPct != null ? `${signed(r.evPct, 1)}%` : '—'}
          </td>
        </>
      )}
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
