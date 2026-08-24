'use client';

/**
 * ProbabilityLadder — the page's flagship. A column of mintable strikes around the
 * price, each one click from a bet. Clicking a row lights that strike on the surface +
 * pre-fills the ticket; Bet opens the ticket.
 *
 * BOTH DIRECTIONS. A binary at strike K has two sides, and this table used to show
 * only one: every Bet button was hardcoded to the UP side, so half of every market was
 * unreachable from the page's flagship instrument. The Above/Below toggle flips the
 * whole ladder rather than adding a second pair of columns — the sides are exact
 * mirrors (`chanceBelow = 1 − chanceAbove`), so a toggle says everything a doubled
 * table would, keeps Plain at four columns, and guarantees the number in the row is
 * always the number the button next to it places.
 *
 * PAYOUT IS NET. It used to be `1 / chance`, which is the surface's price, not the
 * trader's money: the protocol fee is charged on NOTIONAL, so it scales as 1/p and
 * takes ~4% of an even-money return but ~10% of an 18% longshot's. Quoting gross
 * flattered exactly the rows that flatter least. `netPayoutUp` / `ladderSide` come
 * from lib/markets/v2-fees, the same definition the mint path charges against.
 *
 * TWO TABLES, ONE SOURCE. Plain shows the three things a first-timer needs to decide:
 * the strike, the chance, and what it pays. Pro adds the move needed and the strike's
 * implied vol, and makes every column sortable. Pro does NOT carry the realized
 * hit-rate, edge or EV any more: those are the Edge scanner's entire job, it does them
 * across every expiry instead of one, and carrying them here forced a nine-column
 * table into a horizontal scroll on any screen narrower than a desk monitor.
 *
 * Every rung is a real admission-snapped strike (lib/markets/v2-ladder) and the
 * chance-above is the engine's `upFair`, so nothing here can disagree with the surface.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { num, signed } from '@/lib/format';
import { buildLadder, ladderSide, type LadderRung } from '@/lib/markets/v2-ladder';
import { feeRatesFor, hasFees } from '@/lib/markets/v2-fees';
import { impliedVol, timeToExpiryYears } from '@/lib/svi/svi';
import { Term, useVocab } from './vocab';
import { ShareXButton } from '../share/share-x-button';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

/** A rung plus the reads that depend on the direction being quoted and the clock. */
interface LadderRow extends LadderRung {
  /** Chance the SELECTED side finishes in the money (0..1). */
  chance: number;
  /** What the selected side pays after fees, per dollar committed. */
  netPayout: number;
  /** This strike's implied vol (annualized fraction). */
  iv: number;
}

type SortKey = 'strike' | 'chance' | 'iv' | 'payout';

export function ProbabilityLadder({
  market,
  pricer,
  now,
  skewFeeBps = 0,
  onHighlight,
  onBet,
  onShareOdds,
}: {
  market: V2Market | null;
  pricer: LivePricer | null | undefined;
  now: number;
  /** Our own fee rate, from the on-chain FeeConfig. 0 when the router is off. */
  skewFeeBps?: number;
  onHighlight: (strike: number, isUp: boolean) => void;
  onBet: (strike: number, isUp: boolean) => void;
  /** Share a rung's odds as a card (opens the share dialog in the screen). */
  onShareOdds?: (r: LadderRung, isUp: boolean) => void;
}) {
  const { pro } = useVocab();
  // Which way the ladder is read. Above is the default because the rungs are
  // generated from chance-ABOVE targets, so it is the orientation the spread of
  // strikes was designed around.
  const [isUp, setIsUp] = useState(true);
  // Strike ascending by default (chance runs high → low, top → bottom), which is how the
  // ladder reads against the surface. Sorting is a Pro affordance.
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'strike', desc: false });

  const rates = useMemo(() => feeRatesFor(market, skewFeeBps), [market, skewFeeBps]);

  const rungs = useMemo(
    () => (pricer ? buildLadder(pricer, market?.admission_tick_size ?? '1000000000', undefined, rates) : []),
    [pricer, market?.admission_tick_size, rates],
  );

  // Per-rung reads: the selected side's chance and net payout, plus this strike's
  // implied vol.
  const rows = useMemo<LadderRow[]>(() => {
    if (!pricer || !market) return [];
    const tYears = Math.max(timeToExpiryYears(market.expiry, now), 1e-9);
    return rungs.map((r) => {
      const side = ladderSide(r, isUp, rates);
      return {
        ...r,
        chance: side.chance,
        netPayout: side.netPayout,
        iv: impliedVol(r.strike, pricer.forward, pricer.svi, tYears),
      };
    });
  }, [rungs, pricer, market, now, isUp, rates]);

  const sorted = useMemo(() => {
    if (!pro) return rows;
    const val = (r: LadderRow): number => {
      switch (sort.key) {
        case 'chance':
          return r.chance;
        case 'iv':
          return r.iv;
        case 'payout':
          return r.netPayout;
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
      <DirectionToggle isUp={isUp} onChange={setIsUp} />

      {/* Plain is FLUID: four columns fit a phone, and a min-width would have made a
          first-timer scroll sideways to reach the Bet button. Pro keeps a floor and
          scrolls inside this card, but a far lower one than the nine-column table
          needed — six columns clear a laptop without scrolling at all. */}
      <table className={`mt-3 w-full border-collapse ${pro ? 'min-w-[620px]' : ''}`}>
        <thead>
          <tr className="text-[10.5px] uppercase tracking-wide text-text-3">
            <SortTh k="strike" sort={sort} onClick={toggle} pro={pro} className="text-left">
              Strike
            </SortTh>
            <SortTh k="chance" sort={sort} onClick={toggle} pro={pro}>
              {/* The honest header is "Chance above/below", but it is also the widest
                  cell in a four-column table on a 390px phone — enough to push the Bet
                  button off the edge. The short form only appears where the long one
                  does not fit; the toggle above the table already says which way. */}
              {pro ? (
                isUp ? 'P(above)' : 'P(below)'
              ) : (
                <>
                  <span className="sm:hidden">Chance</span>
                  <span className="hidden sm:inline">{isUp ? 'Chance above' : 'Chance below'}</span>
                </>
              )}
            </SortTh>
            {pro && (
              <>
                <Th>Δ to strike</Th>
                <SortTh k="iv" sort={sort} onClick={toggle} pro={pro}>
                  IV
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
              isUp={isUp}
              onHighlight={() => onHighlight(r.strike, isUp)}
              onBet={() => onBet(r.strike, isUp)}
              onShare={onShareOdds && pro ? () => onShareOdds(r, isUp) : undefined}
            />
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex flex-wrap justify-between gap-2 text-[11.5px] text-text-3">
        <span>
          {pro
            ? `Payout is net of fees, per dollar committed.${hasFees(rates) ? ' Gross is 1 / chance; the fee is charged on notional, so it costs more the longer the odds.' : ''}`
            : 'Payout is what $1 comes back as if you are right, after fees.'}
        </span>
        <span>Settles on the price at expiry, not a touch.</span>
      </div>
    </div>
  );
}

/**
 * The Above / Below switch. Flips which side of every strike the table quotes and
 * places, so the whole market is reachable without a second set of columns.
 */
function DirectionToggle({ isUp, onChange }: { isUp: boolean; onChange: (up: boolean) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <span className="text-[11px] uppercase tracking-wide text-text-3">Betting BTC lands</span>
      <div role="group" aria-label="Bet direction" className="inline-flex gap-0.5 rounded-lg border border-line bg-bg-2 p-0.5">
        {([true, false] as const).map((up) => (
          <button
            key={String(up)}
            type="button"
            aria-pressed={isUp === up}
            onClick={() => onChange(up)}
            className={`rounded-md px-3 py-1 text-[12px] font-medium transition ${
              isUp === up
                ? up
                  ? 'bg-(--accent-soft) text-accent ring-1 ring-inset ring-(--accent-line)'
                  : 'bg-down/10 text-down ring-1 ring-inset ring-down/30'
                : 'text-text-2 hover:text-text-1'
            }`}
          >
            {up ? 'Above ↑' : 'Below ↓'}
          </button>
        ))}
      </div>
    </div>
  );
}

function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <th className={`border-b border-line px-2 pb-2.5 text-right font-medium sm:px-3.5 ${className}`}>{children}</th>;
}

/** A header cell that sorts in Pro and is plain text in Plain (nothing to sort when the
 *  table is four columns read top-to-bottom against the surface). */
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
    <th className={`border-b border-line px-2 pb-2.5 text-right font-medium sm:px-3.5 ${className}`}>
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
  isUp,
  onHighlight,
  onBet,
  onShare,
}: {
  r: LadderRow;
  pro: boolean;
  isUp: boolean;
  onHighlight: () => void;
  onBet: () => void;
  onShare?: () => void;
}) {
  return (
    <tr
      onClick={onHighlight}
      className={`group cursor-pointer border-b border-line/60 font-mono text-[13px] transition hover:bg-white/2.5 ${r.isAtm ? 'bg-(--accent-soft)' : ''}`}
    >
      <td className={`px-2 py-2.5 text-left tabular-nums sm:px-3.5 ${r.isAtm ? 'font-semibold text-accent' : 'text-text-1'}`}>
        ${num(r.strike, 0)}
        {r.isAtm && (
          <span className="ml-1.5 whitespace-nowrap rounded border border-(--accent-line) px-1.5 py-px font-sans text-[9.5px] tracking-wide text-accent sm:ml-2">
            AT PRICE
          </span>
        )}
      </td>
      <td className="px-2 py-2.5 text-right tabular-nums sm:px-3.5">
        <span className="inline-flex items-center justify-end gap-2">
          <span className="hidden h-1.5 w-16 overflow-hidden rounded border border-line bg-bg-3 sm:block">
            {/* Fixed precision on purpose. The raw float rendered 82.0889% on the server
                and 82.08890101959425% on the client (the snapshot the server prices from
                carries fewer digits than the live pricer the client re-reads), and React
                treats that as a hydration mismatch. The bar is 64px wide, so two decimals
                is already finer than a pixel — rounding costs nothing and removes the whole
                class of drift. */}
            <span
              className={`block h-full ${isUp ? 'bg-accent/70' : 'bg-down/70'}`}
              style={{ width: `${(r.chance * 100).toFixed(2)}%` }}
            />
          </span>
          {(r.chance * 100).toFixed(0)}%
        </span>
      </td>
      {pro && (
        <>
          <td className={`px-2 py-2.5 text-right tabular-nums sm:px-3.5 ${r.movePct >= 0 ? 'text-up' : 'text-down'}`}>{signed(r.movePct, 2)}%</td>
          <td className="px-2 py-2.5 text-right tabular-nums text-text-2 sm:px-3.5">{(r.iv * 100).toFixed(1)}%</td>
        </>
      )}
      <td className="px-2 py-2.5 text-right tabular-nums sm:px-3.5">{r.netPayout.toFixed(2)}×</td>
      <td className="px-2 py-2.5 text-right sm:px-3.5">
        <span className="inline-flex items-center justify-end gap-1.5">
          {/* Hover-only, so on a touch screen it is invisible AND unreachable — but it
              still took ~26px of the row, which was the last thing pushing the Bet button
              past the edge of a 390px phone. Desktop keeps it. */}
          {onShare && (
            // The hide + hover-reveal live on a WRAPPER, not on the button. Passing
            // `hidden … sm:inline-flex` into the button set `display` twice on one element
            // (the button sets its own `grid`), so Tailwind's emit order decided the winner
            // rather than the class list: at sm+ the button resolved to inline-flex, where
            // `place-items-center` centres nothing horizontally (justify-items is a no-op in
            // flex), and the icon sat against the left edge of its box. The wrapper owns
            // visibility, the button owns its own layout, and neither can clobber the other.
            <span className="hidden opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 sm:inline-flex">
              <ShareXButton onClick={onShare} label="Share these odds" />
            </span>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onBet();
            }}
            className={`rounded-md px-2.5 py-1 font-sans text-[12px] font-medium ring-1 ring-inset transition sm:px-3 ${
              isUp
                ? 'bg-(--accent-soft) text-accent ring-(--accent-line) hover:bg-accent/20'
                : 'bg-down/10 text-down ring-down/30 hover:bg-down/20'
            }`}
          >
            Bet {isUp ? '↑' : '↓'}
          </button>
        </span>
      </td>
    </tr>
  );
}
