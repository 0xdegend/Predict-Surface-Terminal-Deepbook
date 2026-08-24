'use client';

/**
 * OurBook — where the money actually is, on the market you are looking at.
 *
 * This is the panel the page was missing. "Positioning & flow" showed Deribit's pin,
 * ETF inflows and an exchange-wide long/short gauge: real numbers about a different
 * market on a different clock. Meanwhile our own order feed, which is complete and
 * live and describes exactly the expiry on screen, appeared nowhere on the page.
 *
 * Four reads, all ours:
 *   • interest by strike, plotted against the same strikes the ladder offers, so the
 *     crowd's positions line up visually with the rungs you can click
 *   • the up/down lean, weighted by premium rather than by bet count
 *   • our max pain — the settlement price that pays this book least
 *   • the biggest single bet on the market right now
 *
 * Thin books tell you nothing, and pretending otherwise is worse than saying so, so
 * the pin is suppressed below `MIN_PAIN_BETS` (the aggregator's rule, not this
 * component's) and the whole panel says plainly when nobody has traded yet.
 */
import { compact, num } from '@/lib/format';
import { MIN_PAIN_BETS, type MarketBook } from '@/lib/analytics/market-book';
import { Term } from './vocab';

export function OurBook({
  book,
  forward,
  isLoading,
  onPick,
}: {
  book: MarketBook;
  /** Today's price, drawn as a reference line through the strike ladder. */
  forward: number | null;
  isLoading?: boolean;
  /** Click a strike bar to light it on the surface + pre-fill the ticket. */
  onPick?: (strike: number, isUp: boolean) => void;
}) {
  if (isLoading && book.bets === 0) {
    return (
      <div className="glass rounded-lg p-4">
        <div className="h-24 animate-pulse rounded bg-white/5" />
      </div>
    );
  }

  if (book.bets === 0) {
    return (
      <div className="glass rounded-lg p-4 text-[12.5px] leading-relaxed text-text-3">
        No bets on this expiry yet. Yours would be the first.
      </div>
    );
  }

  const peak = Math.max(...book.strikes.map((k) => k.stakeUsd), 1e-9);
  const upPct = book.upShare * 100;

  return (
    <div className="glass rounded-lg p-4">
      {/* The four figures, before the shape. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Cell label={<Term plain="Money on this expiry" pro="Premium staked" />}>
          <div className="font-mono text-[21px] tabular-nums text-text-1">${compact(book.stakeUsd)}</div>
          <Sub>
            {book.bets} {book.bets === 1 ? 'bet' : 'bets'} from {book.traders}{' '}
            {book.traders === 1 ? 'trader' : 'traders'}
          </Sub>
        </Cell>

        <Cell label={<Term plain="Which way they are betting" pro="Up / down, by premium" />}>
          <div className="flex h-2 overflow-hidden rounded-full bg-white/5">
            <span className="bg-up/70" style={{ width: `${upPct.toFixed(2)}%` }} />
            <span className="bg-down/70" style={{ width: `${(100 - upPct).toFixed(2)}%` }} />
          </div>
          <div className="flex justify-between font-mono text-[10.5px]">
            <span className="text-up">{upPct.toFixed(0)}% up</span>
            <span className="text-down">{(100 - upPct).toFixed(0)}% down</span>
          </div>
          {book.rangeStakeUsd > 0 && <Sub>plus ${compact(book.rangeStakeUsd)} on range bets</Sub>}
        </Cell>

        <Cell label={<Term plain="Cheapest place to land" pro="Max pain · our book" />}>
          {book.maxPain != null ? (
            <>
              <div className="font-mono text-[21px] tabular-nums text-text-1">${num(book.maxPain, 0)}</div>
              <Sub>
                <Term
                  plain="Where the fewest bets get paid, so the book pays out least."
                  pro="Settlement price minimising total payout across open positions."
                />
              </Sub>
            </>
          ) : (
            <>
              <div className="font-mono text-[21px] tabular-nums text-text-3">—</div>
              <Sub>Needs at least {MIN_PAIN_BETS} bets to mean anything.</Sub>
            </>
          )}
        </Cell>

        <Cell label={<Term plain="Biggest bet so far" pro="Largest single mint" />}>
          {book.biggest ? (
            <>
              <div className="font-mono text-[21px] tabular-nums text-text-1">${compact(book.biggest.stakeUsd)}</div>
              <Sub>
                {book.biggest.side === 'range' ? (
                  'on a range'
                ) : (
                  <>
                    <span className={book.biggest.side === 'up' ? 'text-up' : 'text-down'}>
                      {book.biggest.side === 'up' ? 'above' : 'below'}
                    </span>{' '}
                    {book.biggest.strike != null ? `$${num(book.biggest.strike, 0)}` : ''}
                  </>
                )}
              </Sub>
            </>
          ) : (
            <div className="font-mono text-[21px] tabular-nums text-text-3">—</div>
          )}
        </Cell>
      </div>

      {/* Interest by strike. Our own version of the thing the page used to borrow. */}
      {book.strikes.length > 0 && (
        <div className="glass-divider-top mt-4 pt-3">
          <div className="mb-2 text-[10.5px] uppercase tracking-wide text-text-3">
            <Term plain="Where the bets are sitting" pro="Open interest by strike" />
          </div>
          <div className="flex flex-col gap-1">
            {book.strikes.map((k) => {
              const upW = (k.up.stakeUsd / peak) * 100;
              const dnW = (k.down.stakeUsd / peak) * 100;
              // Which side owns this strike decides what a click pre-fills.
              const leansUp = k.up.stakeUsd >= k.down.stakeUsd;
              const atPrice = forward != null && book.strikes.length > 1 && nearest(book.strikes.map((s) => s.strike), forward) === k.strike;
              const row = (
                <>
                  <span
                    className={`w-20 shrink-0 text-right font-mono text-[11.5px] tabular-nums ${
                      atPrice ? 'font-semibold text-accent' : 'text-text-2'
                    }`}
                  >
                    ${num(k.strike, 0)}
                  </span>
                  <span className="relative h-3 flex-1 overflow-hidden rounded bg-white/4">
                    <span className="absolute inset-y-0 left-0 bg-up/60" style={{ width: `${upW.toFixed(2)}%` }} />
                    <span
                      className="absolute inset-y-0 bg-down/60"
                      style={{ left: `${upW.toFixed(2)}%`, width: `${dnW.toFixed(2)}%` }}
                    />
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono text-[11.5px] tabular-nums text-text-3">
                    ${compact(k.stakeUsd)}
                  </span>
                </>
              );
              return onPick ? (
                <button
                  key={k.strike}
                  type="button"
                  onClick={() => onPick(k.strike, leansUp)}
                  className="flex items-center gap-2.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-white/4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  title={`Bet ${leansUp ? 'above' : 'below'} $${num(k.strike, 0)}`}
                >
                  {row}
                </button>
              ) : (
                <div key={k.strike} className="flex items-center gap-2.5 px-1 py-0.5">
                  {row}
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] text-text-3">
            <span className="text-up">Green</span> is money betting above the level,{' '}
            <span className="text-down">red</span> below. Click a level to load it.
          </p>
        </div>
      )}
    </div>
  );
}

/** The value in `xs` closest to `target`. */
function nearest(xs: number[], target: number): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const x of xs) {
    const d = Math.abs(x - target);
    if (d < bestD) {
      bestD = d;
      best = x;
    }
  }
  return best;
}

function Cell({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="glass-inset flex flex-col gap-2 p-3.5">
      <div className="text-[10.5px] uppercase tracking-wide text-text-3">{label}</div>
      {children}
    </div>
  );
}

function Sub({ children }: { children: React.ReactNode }) {
  return <div className="mt-auto text-[11px] leading-snug text-text-3">{children}</div>;
}
