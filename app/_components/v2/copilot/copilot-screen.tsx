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
import { LuSparkles } from 'react-icons/lu';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { useV2Markets } from '@/lib/hooks/use-v2-markets';
import { useV2Pricer } from '@/lib/hooks/use-v2-pricer';
import { useV2Pricers } from '@/lib/hooks/use-v2-pricers';
import { useBtcInsights } from '@/lib/hooks/use-btc-insights';
import { useNow } from '@/lib/hooks/use-now';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useV2PortfolioPositions } from '@/lib/hooks/use-v2-portfolio-positions';
import type { BtcCandles } from '@/lib/hooks/use-strike-analysis';
import { SurfaceMountV2 } from '../surface/surface-mount';
import { V2PositionsPanel } from '../positions-panel';
import { V2CopilotTicketModal } from './copilot-ticket-modal';
import { CopilotChat, type ChatMessage } from './copilot-chat';
import { parseIntent } from '@/lib/copilot/intents';
import { respondToIntent, type BetCandidate, type BetSuggestion, type CopilotReply } from '@/lib/copilot/respond';
import { startFlow, advanceFlow, type TradeFlow } from '@/lib/copilot/flow';
import { pythSpot, qkV2 } from '@/lib/api/v2/client';
import type { SmileInput } from '@/lib/svi/surface';
import type { Oracle } from '@/lib/api/types';
import type { V2Market, PythObservation } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

const GREETING: ChatMessage = {
  id: 'greet',
  role: 'assistant',
  text: [
    "Hi — I'm your Predict co-pilot. Tell me which way you think BTC goes and how bold you want to be, and I'll set the bet up for you.",
    'Try “analyze BTC”, “safe up bet”, or say “set up a trade” and I’ll walk you through it step by step.',
  ],
};

// ── Coming-soon gate ────────────────────────────────────────────────────────
// The co-pilot ships to production behind a "coming soon" overlay: the REAL live
// surface + a sample conversation render underneath (blurred, non-interactive) so
// the page teases the finished thing rather than a blank mock. To take it live,
// set NEXT_PUBLIC_COPILOT_LIVE=1 in the environment (a one-switch flip — no code
// change), or hardcode this to `true`.
const COPILOT_LIVE = process.env.NEXT_PUBLIC_COPILOT_LIVE === '1';

// A short, believable exchange to blur behind the overlay — shows the co-pilot
// reading the market and handing back a concrete bet (plain language, no jargon).
// The bet card's countdown/price are live, so even blurred it reads as alive.
function previewMessages(serverNow: number): ChatMessage[] {
  return [
    GREETING,
    { id: 'p1', role: 'user', text: ['Analyze BTC for the next 5 minutes'] },
    {
      id: 'p2',
      role: 'assistant',
      text: [
        'BTC is holding around $66,200 and the mood is calm — no strong push either way right now.',
        'For the next 5 minutes only a small move is priced in, so the safer bets sit close to the current price. Want a bigger payout? You’d bet on a sharper move.',
      ],
    },
    { id: 'p3', role: 'user', text: ['Set up a safe up bet'] },
    {
      id: 'p4',
      role: 'assistant',
      text: [
        'Here’s a safer UP bet on the 5-minute market — it wins as long as BTC stays above a strike just under where it is now.',
        'I’ve loaded it into your ticket and lit it up on the surface. Review the amount and place it whenever you’re ready.',
      ],
      bet: {
        marketId: 'preview',
        expiry: serverNow + 5 * 60_000,
        dir: 'up',
        isUp: true,
        strikePrice: 66_000,
        prob: 0.72,
        payoutMult: 1.36,
        conviction: 'safe',
        timeLeftLabel: '5m',
      },
    },
  ];
}

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
  // Read the live spot the SAME way the top tape does — but imperatively from the
  // query cache at send-time (the tape's query already keeps it fresh), NOT via a
  // hook subscription, so this screen doesn't re-render every 1.5s and drag the
  // heavy surface with it. The co-pilot quotes this as "BTC now" so its price
  // matches the tape; pricing math still uses each market's on-chain forward.
  const queryClient = useQueryClient();
  const readSpot = () => pythSpot(queryClient.getQueryData<PythObservation | null>(qkV2.pythLatest) ?? null);

  // The connected account's DUSDC, for a "what's my balance?" answer. The surface
  // already subscribes to this hook (for its position pins), and it only refetches
  // ~every 12s, so reading it here adds no meaningful re-render load.
  const acct = usePredictAccountV2();
  const readWallet = () => ({
    connected: !!acct.owner,
    hasAccount: acct.wrapperExists,
    accountBase: acct.balanceBase,
    walletBase: acct.walletDusdcBase,
  });

  // The recent 1-minute BTC tape, for the co-pilot's empirical "how often has this
  // actually happened?" answers. Shares the ticket's cached query key (60s server
  // cache), fetched once per session — no polling, so no churn on the surface.
  const { data: candles } = useQuery<BtcCandles>({
    queryKey: ['insights', 'btc', 'candles'],
    queryFn: async () => {
      const r = await fetch('/api/insights/btc/candles');
      if (!r.ok) throw new Error(`candles ${r.status}`);
      return (await r.json()) as BtcCandles;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

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
    const res = startFlow({ candidates: liveCandidates(), now: Date.now(), spot: readSpot() });
    setFlow(res.flow);
    setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', text: res.reply.text }]);
  }

  function handleSend(text: string) {
    if (thinking) return; // one at a time (the input is disabled too)
    // Date.now() + the cached spot read in an event handler (not render) — keeps
    // the surface from re-rendering every tick just to hold a live clock/price.
    const now = Date.now();
    const spot = readSpot();
    const candidates = liveCandidates();

    // A guided flow (if active) intercepts the reply; otherwise parse the intent —
    // "set up a trade" starts the wizard, everything else is a one-shot answer.
    let reply: CopilotReply;
    let nextFlow: TradeFlow | null = flow;
    if (flow) {
      const res = advanceFlow(flow, text, { candidates, now, spot });
      reply = res.reply;
      nextFlow = res.flow;
    } else {
      const intent = parseIntent(text);
      if (intent.kind === 'start_trade') {
        // Pass the raw message so any inline params (strike/amount/leverage/side)
        // pre-fill the wizard and only the missing pieces get asked.
        const res = startFlow({ candidates, now, spot }, text);
        reply = res.reply;
        nextFlow = res.flow;
      } else {
        reply = respondToIntent(intent, { insights: insights ?? null, candidates, now, spot, wallet: readWallet(), surfaceInputs, closes: candles?.closes ?? null });
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

  // Gated for launch: real (live) surface + a sample chat, blurred behind a
  // "coming soon" overlay. Flip COPILOT_LIVE to take it live.
  if (!COPILOT_LIVE) {
    return <CopilotComingSoon canSurface={canSurface} surfaceInputs={surfaceInputs} markets={markets} serverNow={serverNow} />;
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

        {/* Right — the conversation. Bounded height so it scrolls internally. Once
            a bet is live it shows at the bottom of the thread here (and on the
            surface as a gem), so the trader can watch it perform and close it in
            place — inside the chat — without leaving for /portfolio. */}
        <aside className="flex min-h-[62vh] min-w-0 flex-col bg-bg-0 lg:min-h-0">
          <CopilotChat
            messages={messages}
            onSend={handleSend}
            onPlaceBet={handlePlaceBet}
            onEditBet={handleEditBet}
            busy={thinking}
            threadEnd={<CopilotOpenBets />}
          />
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
 * CopilotComingSoon — the launch gate. The REAL live surface and a sample
 * conversation render underneath, blurred and inert (`inert` + pointer-events-none
 * so nothing is focusable or clickable), with a centred glass card on top. It
 * reuses the exact page grid so the blurred backdrop matches the finished layout —
 * a genuine teaser of what's shipping, not a static mock. Flip COPILOT_LIVE (or
 * NEXT_PUBLIC_COPILOT_LIVE=1) to remove it.
 */
function CopilotComingSoon({
  canSurface,
  surfaceInputs,
  markets,
  serverNow,
}: {
  canSurface: boolean;
  surfaceInputs: SmileInput[];
  markets: V2Market[];
  serverNow: number;
}) {
  const preview = useMemo(() => previewMessages(serverNow), [serverNow]);
  const noop = () => {};
  return (
    <div className="relative flex-1 overflow-hidden lg:h-[calc(100dvh-4rem)] lg:flex-none">
      {/* The real page, behind glass. `inert` takes the whole subtree out of the
          tab order / hit-testing; the blur + slight scale hide the frosted edges. */}
      <div inert aria-hidden className="pointer-events-none h-full select-none blur-[6px]">
        <main className="grid h-full grid-cols-1 gap-px bg-white/6 lg:grid-cols-[minmax(0,1fr)_400px] lg:grid-rows-1">
          <section className="hidden min-w-0 flex-col bg-bg-0 lg:flex lg:min-h-0">
            <div className="min-h-0 flex-1">
              {canSurface ? (
                <SurfaceMountV2 inputs={surfaceInputs} markets={markets} serverNow={serverNow} />
              ) : (
                <div className="grid h-full place-items-center text-[12px] text-text-3">Building the live surface…</div>
              )}
            </div>
          </section>
          <aside className="flex min-h-[62vh] min-w-0 flex-col bg-bg-0 lg:min-h-0">
            <CopilotChat messages={preview} onSend={noop} onPlaceBet={noop} onEditBet={noop} busy={false} />
          </aside>
        </main>
      </div>

      {/* Dim veil for card legibility, then the overlay card itself. */}
      <div className="absolute inset-0 bg-bg-0/55" />
      <div className="absolute inset-0 grid place-items-center px-6">
        <div className="glass-card relative w-full max-w-md overflow-hidden p-9 text-center">
          {/* A soft accent glow bleeding down from behind the mark. */}
          <div aria-hidden className="pointer-events-none absolute left-1/2 top-0 h-40 w-40 -translate-x-1/2 -translate-y-16 rounded-full bg-(--accent-glow) blur-3xl" />
          <div className="relative">
            <span className="relative mx-auto grid h-14 w-14 place-items-center rounded-full bg-(--accent-soft) text-accent ring-1 ring-(--accent-line)">
              {/* A gentle breathing halo — the co-pilot is being built, not idle. */}
              <span aria-hidden className="absolute inset-0 animate-pulse rounded-full bg-(--accent-glow) blur-md" />
              <LuSparkles size={22} className="relative" />
            </span>
            <h1 className="mt-6 text-[22px] font-semibold tracking-tight text-text-1">Talk to the surface</h1>
            <p className="mx-auto mt-3 max-w-sm text-[13.5px] leading-relaxed text-text-2">
              Ask the live volatility surface anything. Get a clear read of the market in plain language, plus a bet
              that’s ready to place.
            </p>
            <p className="mt-5 text-[12px] text-text-3">We’re putting the finishing touches on the co-pilot.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * CopilotOpenBets — the trader's live open bets, shown at the BOTTOM OF THE CHAT
 * THREAD (not a separate rail), so once a trade is placed they can watch it
 * perform and close it right inside the conversation — the same panel + redeem
 * dialog the Trade rail and Portfolio use, so the flows never drift. Reuses
 * `useV2PortfolioPositions` — TanStack dedupes it with the surface pins → zero
 * extra fetches. Renders nothing until there's an open bet, so it adds nothing to
 * the empty thread; its own re-renders (live PnL every tick) stay isolated to
 * this subtree and never reach the heavy surface. A hairline sets it apart from
 * the message bubbles above; the thread's own padding frames it.
 */
function CopilotOpenBets() {
  const acct = usePredictAccountV2();
  const { positions } = useV2PortfolioPositions(acct.accountId);
  const hasOpen = positions.some((p) => p.qty > 0);
  if (!hasOpen) return null;
  return (
    <div className="mt-1 border-t border-line pt-3.5">
      <V2PositionsPanel />
    </div>
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
