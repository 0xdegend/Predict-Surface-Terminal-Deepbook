'use client';

/**
 * V2CopilotScreen — the "talk to the surface" page. A conversation rail drives
 * the SAME shared trade store the normal Trade screen uses, so when the co-pilot
 * suggests a bet it (a) highlights that node on the live surface and (b) pre-fills
 * the trade ticket — one act, because in v2 the highlight and the ticket are both
 * just the store selection. Nothing here signs or mints; the trader reviews the
 * loaded ticket and places it themselves.
 *
 * Reuse map: parse (lib/copilot/intents) → respond (lib/copilot/respond, which
 * leans on buildMarketRead + the v2 strike inversion) → applyBet (the copy-trade
 * pattern: selectMarket + setMode + setIsUp + setStrikePrice + markPicked). The
 * surface + ticket are the existing components, unchanged.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { useV2Markets } from '@/lib/hooks/use-v2-markets';
import { useV2Pricer } from '@/lib/hooks/use-v2-pricer';
import { useV2Pricers } from '@/lib/hooks/use-v2-pricers';
import { useBtcInsights } from '@/lib/hooks/use-btc-insights';
import { useNow } from '@/lib/hooks/use-now';
import { SurfaceMountV2 } from '../surface/surface-mount';
import { V2CopilotTicketModal } from './copilot-ticket-modal';
import { CopilotChat, type ChatMessage } from './copilot-chat';
import { parseIntent } from '@/lib/copilot/intents';
import { respondToIntent, type BetCandidate, type BetSuggestion, type CopilotReply } from '@/lib/copilot/respond';
import { startFlow, advanceFlow, type TradeFlow } from '@/lib/copilot/flow';
import type { SmileInput } from '@/lib/svi/surface';
import type { Oracle } from '@/lib/api/types';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

const GREETING: ChatMessage = {
  id: 'greet',
  role: 'assistant',
  text: [
    "Hi — I'm your Predict co-pilot. Tell me which way you think BTC goes and how bold you want to be, and I'll set the bet up for you.",
    'Try “analyze BTC”, “safe up bet”, or say “set up a trade” and I’ll walk you through it step by step.',
  ],
};

export function V2CopilotScreen({
  markets: initialMarkets,
  pricerSeeds,
  serverNow,
}: {
  markets: V2Market[];
  pricerSeeds: Record<string, LivePricer>;
  serverNow: number;
}) {
  const markets = useV2Markets(initialMarkets);
  const marketId = useV2TradeStore((s) => s.marketId);
  const selectMarket = useV2TradeStore((s) => s.selectMarket);
  const setMode = useV2TradeStore((s) => s.setMode);
  const setIsUp = useV2TradeStore((s) => s.setIsUp);
  const setStrikePrice = useV2TradeStore((s) => s.setStrikePrice);
  const markPicked = useV2TradeStore((s) => s.markPicked);
  const setStake = useV2TradeStore((s) => s.setStake);
  const setLeverage = useV2TradeStore((s) => s.setLeverage);
  const openTicketSheet = useV2TradeStore((s) => s.openTicketSheet);

  const { data: insights } = useBtcInsights();

  const selected = markets.find((m) => m.expiry_market_id === marketId) ?? markets[0] ?? null;
  const { data: pricer } = useV2Pricer(
    selected?.expiry_market_id ?? null,
    selected ? pricerSeeds[selected.expiry_market_id] : undefined,
  );

  const marketIds = useMemo(() => markets.map((m) => m.expiry_market_id), [markets]);
  const pricers = useV2Pricers(marketIds, pricerSeeds, 5_000);

  const surfaceInputs = useMemo<SmileInput[]>(
    () =>
      markets.flatMap((m) => {
        const p = pricers[m.expiry_market_id];
        return p
          ? [{ oracle: { oracle_id: m.expiry_market_id, expiry: m.expiry, underlying_asset: 'BTC' } as unknown as Oracle, svi: p.svi, forward: p.forward }]
          : [];
      }),
    [markets, pricers],
  );
  const canSurface = surfaceInputs.length >= 2;

  const [messages, setMessages] = useState<ChatMessage[]>([GREETING]);
  const [thinking, setThinking] = useState(false);
  // The guided step-by-step wizard's state (null = not in a guided flow).
  const [flow, setFlow] = useState<TradeFlow | null>(null);
  const idRef = useRef(0);
  const nextId = () => `m${idRef.current++}`;
  const replyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (replyTimer.current && clearTimeout(replyTimer.current)), []);

  // Mark a suggested bet on the surface (+ prime the store) — the copy-trade
  // pattern. (selectMarket resets the strike, so pin it AFTER.) This only
  // highlights + pre-fills; it never opens the ticket or signs. A wizard bet also
  // carries the chosen stake + leverage, so the ticket opens fully filled in.
  function applyBet(bet: BetSuggestion) {
    selectMarket(bet.marketId);
    setMode('binary');
    setIsUp(bet.isUp);
    setStrikePrice(bet.strikePrice);
    if (bet.amount != null) setStake(bet.amount);
    if (bet.leverage != null) setLeverage(bet.leverage);
    markPicked();
  }

  // "Place this bet" / "Trade it" → re-apply it (in case the selection drifted to
  // a newer market since) and pop the ticket modal to trade it. Ends any wizard.
  function handlePlaceBet(bet: BetSuggestion) {
    applyBet(bet);
    openTicketSheet();
    setFlow(null);
  }

  // Every open market we can price — shared by the one-shot responder and the
  // guided wizard (which pins one with enough runway to finish).
  function liveCandidates(): BetCandidate[] {
    return markets.flatMap((m) => {
      const p = pricers[m.expiry_market_id];
      return p ? [{ market: m, pricer: p }] : [];
    });
  }

  // "Edit" on the review card → restart the wizard from the first question.
  function handleEditBet() {
    const res = startFlow({ candidates: liveCandidates(), now: Date.now() });
    setFlow(res.flow);
    setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', text: res.reply.text }]);
  }

  function handleSend(text: string) {
    if (thinking) return; // one at a time (the input is disabled too)
    // Date.now() in an event handler (not render) — keeps the surface from
    // re-rendering every second just to hold a live clock.
    const now = Date.now();
    const candidates = liveCandidates();

    // A guided flow (if active) intercepts the reply; otherwise parse the intent —
    // "set up a trade" starts the wizard, everything else is a one-shot answer.
    let reply: CopilotReply;
    let nextFlow: TradeFlow | null = flow;
    if (flow) {
      const res = advanceFlow(flow, text, { candidates, now });
      reply = res.reply;
      nextFlow = res.flow;
    } else {
      const intent = parseIntent(text);
      if (intent.kind === 'start_trade') {
        const res = startFlow({ candidates, now });
        reply = res.reply;
        nextFlow = res.flow;
      } else {
        reply = respondToIntent(intent, { insights: insights ?? null, candidates, now });
        nextFlow = null;
      }
    }

    // The surface reacts immediately; the co-pilot's words follow after a short
    // "typing" beat so the reply reads as processed, not pasted in.
    if (reply.bet) applyBet(reply.bet);
    setFlow(nextFlow);
    setMessages((prev) => [...prev, { id: nextId(), role: 'user', text: [text] }]);
    setThinking(true);
    replyTimer.current = setTimeout(() => {
      setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', text: reply.text, bet: reply.bet }]);
      setThinking(false);
    }, 600);
  }

  if (markets.length === 0) {
    return <div className="card mx-4 my-8 px-4 py-8 text-center text-[13px] text-text-3">No live markets right now — check back in a moment.</div>;
  }

  return (
    <>
      <CopilotAutoAdvance markets={markets} serverNow={serverNow} />
      {/* Desktop: lock main to the viewport (flex-none so the explicit height wins
          over flex-1's basis, grid-rows-1 so the single row is 1fr of that fixed
          height) → each column scrolls INTERNALLY instead of growing the page.
          Mobile: normal flow (flex-1), the page scrolls as usual. */}
      <main className="grid flex-1 grid-cols-1 gap-px bg-white/6 lg:h-[calc(100dvh-4rem)] lg:flex-none lg:grid-cols-[minmax(0,1fr)_400px] lg:grid-rows-1 lg:overflow-hidden">
        {/* Left — JUST the live surface (desktop). It reacts to the conversation:
            a suggested or clicked bet lights up here, and you trade it in place
            (surface click-to-mint) or via the pop-out ticket, so there's no second
            trading UI to wade through. Hidden on mobile (the chat leads there). */}
        <section className="hidden min-w-0 flex-col bg-bg-0 lg:flex lg:min-h-0">
          <div className="min-h-0 flex-1">
            {canSurface ? (
              <SurfaceMountV2 inputs={surfaceInputs} markets={markets} serverNow={serverNow} />
            ) : (
              <div className="grid h-full place-items-center text-[12px] text-text-3">Building the live surface…</div>
            )}
          </div>
        </section>

        {/* Right — the conversation. Bounded height so it scrolls internally. */}
        <aside className="flex min-h-[62vh] min-w-0 flex-col bg-bg-0 lg:min-h-0">
          <CopilotChat messages={messages} onSend={handleSend} onPlaceBet={handlePlaceBet} onEditBet={handleEditBet} busy={thinking} />
        </aside>
      </main>

      {/* The ticket lives in a modal (all breakpoints) — it pops out only when the
          trader taps "Place this bet" (or a surface pick), so the surface owns the
          page instead of a permanent ticket rail. */}
      <V2CopilotTicketModal market={selected} pricer={pricer} serverNow={serverNow} />
    </>
  );
}

/**
 * Keep the selection on a still-open market so the surface + ticket always show
 * something before the user talks — a copy of the Trade screen's auto-advancer,
 * isolated in a null child so only IT re-renders each second (not the surface).
 */
function CopilotAutoAdvance({ markets, serverNow }: { markets: V2Market[]; serverNow: number }) {
  const now = useNow(serverNow);
  const marketId = useV2TradeStore((s) => s.marketId);
  const marketPinned = useV2TradeStore((s) => s.marketPinned);
  const selectMarket = useV2TradeStore((s) => s.selectMarket);
  useEffect(() => {
    if (markets.length === 0) return;
    const soonest = markets.find((m) => m.expiry > now);
    if (!soonest) return;
    const current = markets.find((m) => m.expiry_market_id === marketId);
    if (marketPinned && current && current.expiry > now) return;
    if (soonest.expiry_market_id !== marketId) selectMarket(soonest.expiry_market_id, false);
  }, [markets, marketId, marketPinned, now, selectMarket]);
  return null;
}
