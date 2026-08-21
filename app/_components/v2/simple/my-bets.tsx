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
 * THE SAME ROW AS PORTFOLIO, not a lookalike. It renders `V2PositionRow`, the exact
 * component the Portfolio's compact view uses, so the two can never drift: same orb,
 * same `BTC ≥ 77,287.86` condition line, same Won/Live chip, same Payout and Realized
 * columns, same Share / explorer / Claim actions. A restyled copy would have matched for
 * about a week. This also means a bet placed here reads identically wherever the trader
 * next sees it, which is the point of the simple screen being a front-end rather than a
 * second product.
 *
 * Rows come from `useV2PortfolioPositions`, the same enriched source Portfolio and the
 * advanced rail read, so TanStack dedupes all three down to one fetch.
 *
 * CLAIMING works here through the shared `useRedeemFlow` — same dialog, celebration and
 * bookkeeping as Portfolio, so nothing about a claim depends on which screen it was made
 * from. Most settled wins need no action at all: the keeper redeems them within seconds
 * and the row says "Paying out" ([[keeper-redeem-read-gap]]). The button is for the times
 * it is late.
 *
 * RANGE positions are filtered out — they can only be opened from the advanced screen.
 */
import Link from 'next/link';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useMounted } from '@/lib/hooks/use-mounted';
import { useV2PortfolioPositions } from '@/lib/hooks/use-v2-portfolio-positions';
import { V2PositionRow } from '../position-row';
import { useRedeemFlow } from '../use-redeem-flow';

/** Bets listed before deferring to Portfolio. Rows are dense, but a wall of them would
 *  bury the round itself, which is what the screen is for. */
const MAX_SHOWN = 5;

export function MyBets({ now }: { now: number }) {
  const acct = usePredictAccountV2();
  // SSR has no wallet but the client restores one synchronously — branch on the owner
  // only after mount so the server and first client paint agree.
  const mounted = useMounted();
  const { positions } = useV2PortfolioPositions(acct.accountId, acct.owner);
  const redeem = useRedeemFlow();

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
      {/* Same `gap-2` stack Portfolio's compact view uses. */}
      <div className="flex flex-col gap-2">
        {shown.map((p) => (
          <V2PositionRow key={p.key} position={p} now={now} busy={redeem.busy} onRedeem={redeem.open} />
        ))}
      </div>
      {redeem.overlay}
    </section>
  );
}
