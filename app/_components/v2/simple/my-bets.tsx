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
 * A LIST, laid out like the advanced rail's open positions (same `glass-card` row, same
 * direction pill, same action button on the right), so a trader who moves between the two
 * screens reads the same shape in both places. What differs is the WORDING, and only
 * where the simple screen has a better answer: "Winning right now" instead of a
 * mark-to-market PnL, because on a binary that figure moves with the odds rather than
 * with whether you are going to win, which is the one question this list exists for.
 *
 * CLAIMING happens here too, through the shared `useRedeemFlow` — the same dialog,
 * celebration and bookkeeping as the rail and Portfolio, so nothing about a claim depends
 * on which screen it was made from. Most settled wins need no action: the keeper redeems
 * them within seconds and the row says so ([[keeper-redeem-read-gap]]). The button is for
 * the times it is late.
 *
 * RANGE positions are filtered out. They can only be opened from the advanced screen, and
 * a band has no answer to "am I up or down right now".
 */
import Link from 'next/link';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useMounted } from '@/lib/hooks/use-mounted';
import { useV2PortfolioPositions } from '@/lib/hooks/use-v2-portfolio-positions';
import { positionWinPayout, settledClaimState, type V2PortfolioPosition } from '@/lib/portfolio/v2';
import { useRedeemFlow } from '../use-redeem-flow';
import { price } from '@/lib/format';
import { clock } from './cadence';

/** Bets listed before deferring to Portfolio. Rows are cheap, so this can be taller than
 *  the card layout allowed — but a wall of them would bury the round below. */
const MAX_SHOWN = 5;

export function MyBets({ spot, now }: { spot: number | null; now: number }) {
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
      <div className="flex flex-col gap-2">
        {shown.map((p) => (
          <BetRow key={p.key} p={p} spot={spot} now={now} busy={redeem.busy} onAct={() => redeem.open(p)} />
        ))}
      </div>
      {redeem.overlay}
    </section>
  );
}

function BetRow({
  p,
  spot,
  now,
  busy,
  onAct,
}: {
  p: V2PortfolioPosition;
  spot: number | null;
  now: number;
  busy: boolean;
  onAct: () => void;
}) {
  const isUp = p.direction !== 'Down';
  const claim = settledClaimState(p, now);
  const win = positionWinPayout(p);
  const secsLeft = p.expiry != null ? Math.max(0, Math.round((p.expiry - now) / 1000)) : null;

  // "Am I winning?" answered the same way the round will be: spot against the line, in
  // the direction bet.
  const ahead = spot != null && p.strike != null ? (isUp ? spot >= p.strike : spot < p.strike) : null;
  const won = p.settled ? p.won === true : null;

  const status: { text: string; tone: string } = p.settled
    ? won
      ? { text: claim === 'auto_paying' ? `Won $${price(win)}, paying out` : `Won $${price(win)}`, tone: 'text-up' }
      : { text: 'Lost', tone: 'text-text-3' }
    : ahead == null
      ? { text: 'Waiting for the price…', tone: 'text-text-3' }
      : ahead
        ? { text: 'Winning right now', tone: 'text-up' }
        : { text: 'Behind right now', tone: 'text-down' };

  return (
    <div className={`glass-card interactive flex items-center justify-between gap-3 py-2.5 pl-3.5 pr-2 ${isUp ? 'up' : 'down'}`}>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex items-baseline gap-2">
          <span className={`text-[10px] font-semibold uppercase tracking-wider ${isUp ? 'text-up' : 'text-down'}`}>
            {isUp ? '↑ Up from' : '↓ Down from'}
          </span>
          <span className="truncate font-mono text-[13px] font-semibold tabular-nums text-text-1">
            {p.strike != null ? price(p.strike) : '—'}
          </span>
        </span>
        <span className="flex flex-wrap items-baseline gap-x-2 text-[11.5px]">
          <span className={`font-semibold ${status.tone}`}>{status.text}</span>
          {!p.settled && (
            <span className="font-mono tabular-nums text-text-3">
              ${price(p.cost ?? 0)} → <span className="font-semibold text-text-1">${price(win)}</span>
              {secsLeft != null && <span className="text-text-3">{` · ${clock(secsLeft)} left`}</span>}
            </span>
          )}
        </span>
      </div>
      {/* The keeper settles nearly everything on its own, so most rows carry a note rather
          than a button. An action appears when a bet is still live (close early), or when
          the keeper is clearly late on a win or a loss. */}
      {claim === 'auto_paying' ? (
        <span className="shrink-0 px-2.5 py-1 text-[10.5px] text-up/80">Paying out…</span>
      ) : claim === 'auto_clearing' ? (
        <span className="shrink-0 px-2.5 py-1 text-[10.5px] text-text-3">Settling…</span>
      ) : (
        <button
          type="button"
          onClick={onAct}
          disabled={busy || p.sample}
          className="ctrl-soft shrink-0 rounded-md px-3 py-1.5 text-[11.5px] font-medium text-text-2 disabled:opacity-50"
        >
          {claim === 'claim_fallback' ? 'Claim' : claim === 'clear_fallback' ? 'Clear' : 'Close early'}
        </button>
      )}
    </div>
  );
}
