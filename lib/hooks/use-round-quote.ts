'use client';

/**
 * use-round-quote — everything simple mode needs to price ONE round: its live pricer,
 * its pinned LINE, and both sides quoted at the trader's stake.
 *
 * The hero ticket and every round card ask the same question of a different market, so
 * this is the single place that answers it — a card and the ticket can't disagree about
 * a line or a multiplier, because they run identical code.
 *
 * Safe to call with a null market (both queries idle), so callers can hold a stable
 * hook order while the active round rolls over. See [[simple-mode]].
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useV2Pricer } from '@/lib/hooks/use-v2-pricer';
import { getV2MarketState, qkV2 } from '@/lib/api/v2/client';
import { roundLineScaled, quoteSide, lineIsTradeable, type SideQuote } from '@/lib/sui/v2/simple-round';
import { snapStrikeToAdmission } from '@/lib/sui/v2/ticks';
import { toFloat, fromFloat } from '@/config/scale';
import type { V2Market, V2MarketState } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

export interface RoundQuote {
  pricer: LivePricer | null;
  /** The round's line, 1e9-scaled, plus whether it's pinned on-chain or an ATM fallback. */
  lineInfo: { lineScaled: bigint; pinned: boolean } | null;
  /** The line as a float — null until the pricer lands. */
  line: number | null;
  upQ: SideQuote | null;
  dnQ: SideQuote | null;
  /** True once the round can actually be quoted (pricer + line are in). */
  ready: boolean;
}

export function useRoundQuote(
  market: V2Market | null,
  stake: number,
  seeds?: { pricer?: LivePricer; state?: V2MarketState },
): RoundQuote {
  const marketId = market?.expiry_market_id ?? null;
  const pricerQ = useV2Pricer(marketId, seeds?.pricer);
  const pricer = pricerQ.data ?? null;

  // The pinned line comes from the market's on-chain reference_tick; seed it from the
  // server where we have it so the line paints immediately instead of flashing ATM.
  const stateQ = useQuery({
    queryKey: qkV2.marketState(marketId ?? ''),
    queryFn: () => getV2MarketState(marketId!),
    enabled: !!marketId,
    initialData: seeds?.state,
    refetchInterval: 8_000,
    staleTime: 5_000,
  });
  const refTick = stateQ.data?.reference_tick ?? null;
  // Whether we've actually HEARD from the chain about this market yet. `refTick == null`
  // alone conflates "this round has no pinned line" with "we haven't looked yet", and
  // guessing during the gap is what made the line visibly walk for a few seconds at
  // every rollover: the fallback below tracks spot, so an unanswered market drifts.
  const stateKnown = stateQ.data !== undefined;

  // The at-the-money fallback, for rounds the chain has NOT pinned (hourly, and any
  // market before the keeper sets its reference_tick).
  const atmScaled =
    market && pricer ? snapStrikeToAdmission(fromFloat(pricer.forward), market.admission_tick_size) : null;

  /**
   * HOLD that fallback still. Recomputing it every pricer refresh (~2.5s) walked the
   * round's headline number continuously, which reads as the question itself changing
   * under the trader. So it is picked ONCE per market and kept until it stops being a
   * real two-way bet, then re-picked at the current money.
   *
   * Render-time guarded setState (the codebase's pattern — their eslint forbids
   * setState in an effect, and a ref mutated in render isn't pure). It converges: after
   * a re-pick the held line IS the current ATM, so the condition goes false. The
   * `!== atmScaled` guard is what stops a line that's lopsided but already at the money
   * from re-picking itself forever.
   */
  const [held, setHeld] = useState<{ marketId: string; lineScaled: bigint } | null>(null);
  const needsRepick =
    marketId != null &&
    pricer != null &&
    atmScaled != null &&
    refTick == null &&
    stateKnown &&
    (held?.marketId !== marketId ||
      (!lineIsTradeable(pricer, held.lineScaled) && held.lineScaled !== atmScaled));
  if (needsRepick) setHeld({ marketId, lineScaled: atmScaled });

  const heldScaled = held?.marketId === marketId ? held.lineScaled : null;

  const lineInfo = useMemo(() => {
    if (!market || !pricer) return null;
    // Pinned on-chain: this is the tick the round SETTLES against, so it is the line —
    // never substitute our own, or the question stops matching the outcome.
    if (refTick != null) {
      return roundLineScaled(refTick, pricer.forward, market.tick_size, market.admission_tick_size);
    }
    if (!stateKnown || heldScaled == null) return null; // still finding out — don't guess
    return { lineScaled: heldScaled, pinned: false };
  }, [market, pricer, refTick, stateKnown, heldScaled]);
  const line = lineInfo ? toFloat(lineInfo.lineScaled) : null;

  const upQ = useMemo(
    () => (market && pricer && lineInfo ? quoteSide(market, pricer, lineInfo.lineScaled, stake, true) : null),
    [market, pricer, lineInfo, stake],
  );
  const dnQ = useMemo(
    () => (market && pricer && lineInfo ? quoteSide(market, pricer, lineInfo.lineScaled, stake, false) : null),
    [market, pricer, lineInfo, stake],
  );

  return { pricer, lineInfo, line, upQ, dnQ, ready: !!(pricer && lineInfo) };
}
