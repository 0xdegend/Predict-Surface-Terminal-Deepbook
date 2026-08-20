'use client';

/**
 * RoundCards — the other rounds open right now, under the hero. Each card is a complete
 * little market: its own countdown, its own line, a sparkline of the tape with that line
 * threaded through it, and UP / DOWN buttons that bet on THAT round — at the amount set
 * in the ticket on desktop, or via the bet drawer on mobile, where no amount is on screen.
 *
 * They're all bets on one asset, so what keeps the cards from reading as the same picture
 * three times is horizon: each cadence draws a different sparkline window (see
 * [[cadence]]). Everything else — line, countdown, odds, tint — is per-round data.
 *
 * Pricing goes through the same `useRoundQuote` the hero uses, and betting hands back to
 * the screen's single confirm/mint funnel, so a card bet and a ticket bet are the same
 * trade. Cards never place anything on their own. See [[simple-mode]].
 */
import { useRoundQuote } from '@/lib/hooks/use-round-quote';
import { cadenceOf, isTooCloseToExpiry } from '@/lib/markets/v2-discovery';
import { CADENCE_META, clock } from './cadence';
import { RoundSpark } from './round-spark';
import { SideButton } from './side-button';
import { price } from '@/lib/format';
import type { SpotPoint } from '@/lib/charts/simple-series';
import type { V2Market, V2MarketState } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';
import type { SideQuote } from '@/lib/sui/v2/simple-round';

export interface RoundPick {
  market: V2Market;
  /** The line as a float, for display. */
  line: number;
  /** The SAME line, 1e9-scaled — what the trade is actually built against. Carried so a
   *  downstream step (the mobile drawer) bets on the exact line shown, never its own. */
  lineScaled: bigint;
  quote: SideQuote;
  isUp: boolean;
}

export function RoundCards({
  markets,
  series,
  stake,
  spot,
  now,
  pricerSeeds,
  stateSeeds,
  onPick,
  disabled,
}: {
  markets: V2Market[];
  series: SpotPoint[];
  stake: number;
  spot: number | null;
  now: number;
  pricerSeeds: Record<string, LivePricer>;
  stateSeeds: Record<string, V2MarketState>;
  onPick: (pick: RoundPick) => void;
  disabled: boolean;
}) {
  if (!markets.length) return null;
  return (
    <section className="mt-5">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold tracking-tight text-text-1">Other rounds open now</h2>
        <span className="hidden text-[11px] text-text-3 lg:inline">Bets use the amount set above</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {markets.map((m) => (
          <RoundCard
            key={m.expiry_market_id}
            market={m}
            series={series}
            stake={stake}
            spot={spot}
            now={now}
            pricerSeed={pricerSeeds[m.expiry_market_id]}
            stateSeed={stateSeeds[m.expiry_market_id]}
            onPick={onPick}
            disabled={disabled}
          />
        ))}
      </div>
    </section>
  );
}

function RoundCard({
  market,
  series,
  stake,
  spot,
  now,
  pricerSeed,
  stateSeed,
  onPick,
  disabled,
}: {
  market: V2Market;
  series: SpotPoint[];
  stake: number;
  spot: number | null;
  now: number;
  pricerSeed?: LivePricer;
  stateSeed?: V2MarketState;
  onPick: (pick: RoundPick) => void;
  disabled: boolean;
}) {
  const cadence = cadenceOf(market);
  const meta = CADENCE_META[cadence];
  const { line, lineInfo, upQ, dnQ, ready } = useRoundQuote(market, stake, { pricer: pricerSeed, state: stateSeed });

  const secsLeft = Math.max(0, Math.round((market.expiry - now) / 1000));
  const closed = isTooCloseToExpiry(market, now);
  const above = spot != null && line != null ? spot >= line : true;
  const delta = spot != null && line != null ? spot - line : null;

  return (
    <article
      className="panel relative flex flex-col gap-3 overflow-hidden p-3.5"
      style={{
        background: `radial-gradient(120% 80% at 50% -10%, ${
          above ? 'rgba(77,214,176,0.07)' : 'rgba(240,121,107,0.07)'
        }, transparent 60%), var(--bg-1)`,
      }}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1.5">
          <span className="eyebrow">{meta.short}</span>
          <span className="font-mono text-[15px] font-semibold tabular-nums leading-none text-text-1">
            {line == null ? '—' : price(line)}
          </span>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <span className={`font-mono text-[15px] font-semibold tabular-nums leading-none ${closed ? 'text-text-3' : 'text-text-1'}`}>
            {clock(secsLeft)}
          </span>
          {delta != null && (
            <span className={`text-[11px] font-semibold tabular-nums ${above ? 'text-up' : 'text-down'}`}>
              {above ? '▲' : '▼'} {price(Math.abs(delta))}
            </span>
          )}
        </div>
      </header>

      <div className="h-16 w-full">
        <RoundSpark series={series} line={line} above={above} windowS={meta.sparkWindowS} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <SideButton
          isUp
          size="sm"
          disabled={disabled || closed || !ready || !upQ?.quotable}
          unpriceable={!!upQ && !upQ.quotable}
          onPick={() => line != null && lineInfo && upQ && onPick({ market, line, lineScaled: lineInfo.lineScaled, quote: upQ, isUp: true })}
        />
        <SideButton
          isUp={false}
          size="sm"
          disabled={disabled || closed || !ready || !dnQ?.quotable}
          unpriceable={!!dnQ && !dnQ.quotable}
          onPick={() => line != null && lineInfo && dnQ && onPick({ market, line, lineScaled: lineInfo.lineScaled, quote: dnQ, isUp: false })}
        />
      </div>

      {closed && (
        <p className="text-center text-[10.5px] text-text-3">This round is closing — the next one opens in a moment.</p>
      )}
    </article>
  );
}

