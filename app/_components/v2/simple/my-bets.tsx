'use client';

/**
 * MyBets — the bets you have running right now, on the screen you placed them from.
 *
 * This is the missing half of simple mode rather than a space filler. You could bet on
 * a one-minute round and the screen would tell you nothing afterwards: no position, no
 * result, no payout. The entire payoff moment — on a market that resolves inside a
 * minute — happened off-screen in Portfolio. For a beginner that IS the product loop,
 * and it was the one part not on the page.
 *
 * Reads the same enriched rows as the Portfolio and the advanced trade rail
 * (`useV2PortfolioPositions`), so the three can never disagree and TanStack dedupes the
 * fetches down to one.
 *
 * Two deliberate omissions:
 *   - NO close/claim buttons. The keeper auto-redeems settled winners within seconds
 *     ([[keeper-redeem-read-gap]]), so the common path needs no action at all; anything
 *     that does need a decision belongs in Portfolio, one tap away. Putting a redeem
 *     dialog on the simple screen would import the whole partial-close flow it exists
 *     to avoid.
 *   - RANGE positions are filtered out. They can only be opened from the advanced
 *     screen, and a band has no answer to "am I up or down right now", which is the
 *     only question this strip is here to answer.
 */
import Link from 'next/link';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useMounted } from '@/lib/hooks/use-mounted';
import { useV2PortfolioPositions } from '@/lib/hooks/use-v2-portfolio-positions';
import { positionWinPayout, settledClaimState, type V2PortfolioPosition } from '@/lib/portfolio/v2';
import { price } from '@/lib/format';
import { clock } from './cadence';

/** Bets shown before deferring to Portfolio. Three keeps the strip one row on desktop. */
const MAX_SHOWN = 3;

export function MyBets({ spot, now }: { spot: number | null; now: number }) {
  const acct = usePredictAccountV2();
  // SSR has no wallet but the client restores one synchronously — branch on the owner
  // only after mount so the server and first client paint agree.
  const mounted = useMounted();
  const { positions } = useV2PortfolioPositions(acct.accountId, acct.owner);

  const open = positions.filter((p) => p.qty > 0 && p.direction !== 'Range');
  const shown = open.slice(0, MAX_SHOWN);

  // Quiet by design: a trader with no bets sees the screen they came for, not an empty
  // frame telling them so. The results tape carries the page's baseline content.
  if (!mounted || !acct.owner || open.length === 0) return null;

  return (
    <section className="mt-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold tracking-tight text-text-1">Your bets</h2>
        <Link href="/v2/portfolio" className="text-[11px] text-text-3 underline hover:text-text-1">
          {open.length > MAX_SHOWN ? `View all ${open.length}` : 'Portfolio'} →
        </Link>
      </div>
      {/* Columns track the COUNT, so one or two bets fill the row instead of leaving
          a hole where a third card would go. */}
      <div className={`grid gap-3 ${shown.length >= 3 ? 'sm:grid-cols-2 xl:grid-cols-3' : shown.length === 2 ? 'sm:grid-cols-2' : 'grid-cols-1'}`}>
        {shown.map((p) => (
          <BetCard key={p.key} p={p} spot={spot} now={now} />
        ))}
      </div>
    </section>
  );
}

function BetCard({ p, spot, now }: { p: V2PortfolioPosition; spot: number | null; now: number }) {
  const isUp = p.direction !== 'Down';
  const claim = settledClaimState(p, now);
  const win = positionWinPayout(p);
  const secsLeft = p.expiry != null ? Math.max(0, Math.round((p.expiry - now) / 1000)) : null;

  // "Am I winning?" answered the same way the round will be: spot against the line, in
  // the direction bet. Deliberately not mark-to-market PnL — on a binary that figure
  // moves with the odds, which is a different (and, here, confusing) question.
  const ahead = spot != null && p.strike != null ? (isUp ? spot >= p.strike : spot < p.strike) : null;
  const won = p.settled ? p.won === true : null;

  const status: { text: string; tone: string } = p.settled
    ? won
      ? { text: claim === 'auto_paying' ? `Won ${price(win)} · paying out` : `Won ${price(win)}`, tone: 'text-up' }
      : { text: 'Lost', tone: 'text-text-3' }
    : ahead == null
      ? { text: 'Waiting for the price…', tone: 'text-text-3' }
      : ahead
        ? { text: 'Winning right now', tone: 'text-up' }
        : { text: 'Behind right now', tone: 'text-down' };

  return (
    <article
      className="panel relative flex flex-col gap-2.5 overflow-hidden p-3.5"
      style={{
        background: `radial-gradient(120% 80% at 50% -10%, ${
          isUp ? 'rgba(77,214,176,0.07)' : 'rgba(240,121,107,0.07)'
        }, transparent 60%), var(--bg-1)`,
      }}
    >
      <header className="flex items-start justify-between gap-2">
        <span className="flex flex-col gap-1.5">
          <span className={`text-[10px] font-semibold uppercase tracking-wider ${isUp ? 'text-up' : 'text-down'}`}>
            {isUp ? '↑ Up' : '↓ Down'} from
          </span>
          <span className="font-mono text-[15px] font-semibold tabular-nums leading-none text-text-1">
            {p.strike != null ? price(p.strike) : '—'}
          </span>
        </span>
        <span className="flex flex-col items-end gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-text-3">
            {p.settled ? 'Finished' : 'Closes in'}
          </span>
          <span className="font-mono text-[15px] font-semibold tabular-nums leading-none text-text-1">
            {p.settled || secsLeft == null ? '—' : clock(secsLeft)}
          </span>
        </span>
      </header>

      <div className="flex items-baseline justify-between gap-3 border-t border-(--line-soft) pt-2.5">
        <span className={`text-[11.5px] font-semibold ${status.tone}`}>{status.text}</span>
        {!p.settled && (
          <span className="font-mono text-[11.5px] tabular-nums text-text-3">
            ${price(p.cost ?? 0)} → <span className="font-semibold text-text-1">${price(win)}</span>
          </span>
        )}
      </div>
    </article>
  );
}
