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
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { LuSparkles } from 'react-icons/lu';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { useV2Markets } from '@/lib/hooks/use-v2-markets';
import { useV2Pricer } from '@/lib/hooks/use-v2-pricer';
import { useV2Pricers } from '@/lib/hooks/use-v2-pricers';
import { useBtcInsights, type BtcInsights } from '@/lib/hooks/use-btc-insights';
import { useBtcPositioning } from '@/lib/hooks/use-btc-positioning';
import { useBtcNarrative } from '@/lib/hooks/use-btc-narrative';
import { useNow } from '@/lib/hooks/use-now';
import { usePredictAccountV2, qkV2Account } from '@/lib/hooks/use-predict-account-v2';
import { useStarterGrant } from '@/lib/hooks/use-starter-grant';
import { useV2PortfolioPositions } from '@/lib/hooks/use-v2-portfolio-positions';
import type { BtcCandles } from '@/lib/hooks/use-strike-analysis';
import { SurfaceMountV2 } from '../surface/surface-mount';
import { V2PositionsPanel } from '../positions-panel';
import { V2CopilotTicketModal } from './copilot-ticket-modal';
import { CopilotChat, type ChatMessage } from './copilot-chat';
import { CopilotStatBar } from './copilot-stat-bar';
import { CopilotRead } from './copilot-read';
import { V2MarketPicker } from '../market-picker';
import { parseIntent, isPlaceConfirmation } from '@/lib/copilot/intents';
import { respondToIntent, type BetCandidate, type BetSuggestion, type CopilotReply, type OnboardAction, type ShareCard } from '@/lib/copilot/respond';
import { SuccessModal } from '@/app/_components/ui/success-modal';
import { FearGreedShareModal } from './fear-greed-share-modal';
import {
  marketRows,
  volState,
  arbState,
  bias as pulseBias,
  nextExpiry as pulseNextExpiry,
  suggestChips,
  type VolState,
  type ArbState,
  type Bias,
} from '@/lib/copilot/pulse';
import { startFlow, advanceFlow, type TradeFlow } from '@/lib/copilot/flow';
import { summarizePositions, winningClaimPayout, type PortfolioSummary, type V2PortfolioPosition } from '@/lib/portfolio/v2';
import { planBinaryBudgetMint } from '@/lib/sui/v2/budget-mint';
import { aggregateStrikeVolume, busiestStrikeReply, type StrikeVolume } from '@/lib/copilot/strike-volume';
import { matchPositionsToClose, positionCloseLabel } from '@/lib/copilot/close-match';
import { isTooCloseToExpiry } from '@/lib/markets/v2-discovery';
import { num, quote as fmtQuote } from '@/lib/format';
import { predictV2Config } from '@/config/predict';
import { starterGrant, STARTER_GRANT_BALANCE_CEILING } from '@/config/starter-grant';
import { pythSpot, qkV2, getMarketOrders } from '@/lib/api/v2/client';
import type { SmileInput } from '@/lib/svi/surface';
import type { Oracle } from '@/lib/api/types';
import type { V2Market, PythObservation, V2OrderEvent } from '@/lib/api/v2/types';
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

/**
 * The starter grant only funds a brand-new, near-empty wallet: it's one-time and
 * gated on no trading account yet + a DUSDC balance under the ceiling (the server
 * also drips gas SUI only when the wallet lacks it). A wallet with an account or
 * enough DUSDC would be rejected, so we offer the faucet there instead. Mirrors the
 * trade ticket's grant-CTA gate exactly.
 */
function grantEligibleFor(a: { walletDusdcBase: bigint | undefined; wrapperExists: boolean; balanceBase: bigint }): boolean {
  return (
    starterGrant.enabled &&
    a.walletDusdcBase !== undefined &&
    !a.wrapperExists &&
    a.balanceBase + a.walletDusdcBase < STARTER_GRANT_BALANCE_CEILING
  );
}

/** A faucet-fallback line for when the auto-grant can't run. */
function faucetLine(lead: string): string {
  return predictV2Config.faucetUrl ? `${lead} You can grab test tokens from the faucet: ${predictV2Config.faucetUrl}` : `${lead} Try the testnet faucet to top up.`;
}

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
  const pickRangeLevel = useV2TradeStore((s) => s.pickRangeLevel);
  const setStake = useV2TradeStore((s) => s.setStake);
  const setLeverage = useV2TradeStore((s) => s.setLeverage);
  const openTicketSheet = useV2TradeStore((s) => s.openTicketSheet);
  const pulseFill = useV2TradeStore((s) => s.pulseFill);

  // Both Clawby-backed fetches are gated on COPILOT_LIVE: while the co-pilot ships
  // behind the coming-soon overlay (prod), the page does ZERO Clawby work — no
  // sweep, no 60s polling. It only starts spending once the feature is live
  // (locally, where NEXT_PUBLIC_COPILOT_LIVE=1). See the gate at the render tail.
  const { data: insights } = useBtcInsights({ enabled: COPILOT_LIVE });
  // Positioning & flow (Clawby PRO) — reuses the SAME cached route the Options page
  // uses (60s), so it adds no fetch cost. Feeds the co-pilot's positioning / flow /
  // options-market answers and enriches "Analyze BTC".
  const { data: positioning } = useBtcPositioning({ enabled: COPILOT_LIVE });
  // The "what is X talking about?" chatter aggregate (Clawby PRO x_search), for the
  // "why is BTC moving?" answer. Slow poll (5 min) — chatter drifts over hours, and
  // x_search is the heaviest call, so this adds negligible load.
  const { data: narrative } = useBtcNarrative({ enabled: COPILOT_LIVE });
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
    grantEligible: grantEligibleFor(acct),
  });
  // One-tap "get test tokens" for onboarding — the SAME app-treasury starter grant
  // the trade ticket uses, pointed at v2's wallet-balance query so balances refresh.
  // Gasless (Google) accounts get DUSDC only; external wallets also get gas SUI.
  const grant = useStarterGrant(acct.owner ?? null, !acct.gasless, {
    invalidateKeys: acct.owner ? [qkV2Account.walletDusdc(acct.owner)] : [],
    symbol: predictV2Config.quote.symbol,
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
    enabled: COPILOT_LIVE,
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

  // ── Cockpit pulse ──────────────────────────────────────────────────────────
  // The live derivations the chrome around the chat reads from (stat bar, markets
  // rail, ambient read, adaptive chips). Computed HERE once from primitives the
  // screen already holds, using the SAME lib/svi + respond.ts logic the
  // conversation uses — so a pill can never disagree with the chat. `now`/`spot`
  // are READ from the live tape in the query cache (see below), NOT subscribed, so
  // this never drags the surface into a per-tick re-render; the stat bar and rail
  // own the ticking bits (live spot, countdowns) inside their own leaf subtrees.
  const stageCandidates = useMemo<BetCandidate[]>(
    () => markets.flatMap((m) => (pricers[m.expiry_market_id] ? [{ market: m, pricer: pricers[m.expiry_market_id] }] : [])),
    [markets, pricers],
  );
  // `now` + `spot` come from the live tape in the query cache — READ, never
  // subscribed (exactly like readSpot below) — so the pulse advances on the
  // screen's own cadence without a per-second subscription that would re-render
  // the heavy surface. The tape's own timestamp is the honest clock for market
  // timing; the stat bar and rail still tick their countdowns live via useNow.
  const pythObs = queryClient.getQueryData<PythObservation | null>(qkV2.pythLatest) ?? null;
  const pulseSpot = pythSpot(pythObs);
  const pulseNow = pythObs?.source_timestamp_ms ?? pythObs?.checkpoint_timestamp_ms ?? serverNow;
  // The soonest market's chance-up read (for the ambient "surface read" card).
  const rows = marketRows(stageCandidates, pulseSpot, pulseNow);
  const vol = volState(stageCandidates, candles?.closes, pulseNow);
  const arb = arbState(surfaceInputs, pulseNow);
  const lean = pulseBias(insights ?? null);
  const nextExp = pulseNextExpiry(stageCandidates, pulseNow);
  const chips = suggestChips({ vol, arb, bias: lean, hasPortfolio: !!acct.owner });

  const [messages, setMessages] = useState<ChatMessage[]>([GREETING]);
  const [thinking, setThinking] = useState(false);
  // The share snapshot whose card dialog is open (null = closed). Set when the
  // trader taps "Share to X" under a shareable answer (fear & greed).
  const [shareCard, setShareCard] = useState<ShareCard | null>(null);
  // The guided step-by-step wizard's state (null = not in a guided flow).
  const [flow, setFlow] = useState<TradeFlow | null>(null);
  // The bet currently set up + shown on a card (wizard review or a one-shot
  // suggestion). Lets a typed "trade it" open the ticket, like tapping the button.
  // A ref (not state) so tracking it never re-renders the heavy surface.
  const pendingBetRef = useRef<BetSuggestion | null>(null);
  // Latest roll-up of the trader's own positions, written by the open-bets tray
  // (which already subscribes to them) so "how's my portfolio?" reads it without
  // this screen subscribing — keeps the surface out of the per-tick re-render.
  const portfolioRef = useRef<PortfolioSummary | null>(null);
  // The full position list (same source), so "close my bet" can match + redeem.
  const positionsRef = useRef<V2PortfolioPosition[]>([]);
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

  // Light a strike up on the surface (+ pre-fill the ticket selection) without
  // suggesting a full bet — used by "busiest strike" so the answer's top strike
  // appears on the surface. Same store path as applyBet: selectMarket resets the
  // strike, so set it AFTER. A range bucket seeds both band edges.
  function highlightStrike(b: StrikeVolume) {
    selectMarket(b.marketId);
    if (b.direction === 'range' && b.band) {
      setMode('range');
      pickRangeLevel(b.band.lower);
      pickRangeLevel(b.band.higher);
    } else if (b.strike != null) {
      setMode('binary');
      setIsUp(b.direction === 'up');
      setStrikePrice(b.strike);
    }
    markPicked();
  }

  // "Place this bet" / "Trade it" → re-apply it (in case the selection drifted to
  // a newer market since) and pop the ticket modal to trade it. Ends any wizard.
  function handlePlaceBet(bet: BetSuggestion) {
    applyBet(bet);
    openTicketSheet();
    setFlow(null);
    pendingBetRef.current = null; // it's placed — a later "trade it" shouldn't re-open it
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
    pendingBetRef.current = null; // re-building — don't let a stray "trade it" fire the old one
    const res = startFlow({ candidates: liveCandidates(), now: Date.now(), spot: readSpot() });
    setFlow(res.flow);
    setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', text: res.reply.text }]);
  }

  const pushUser = (t: string) => setMessages((prev) => [...prev, { id: nextId(), role: 'user', text: [t] }]);
  const pushBot = (text: string[]) => setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', text }]);

  // Echo the user's line, then reveal the co-pilot's reply after a short "typing"
  // beat so it reads as processed, not pasted in.
  function pushExchange(userText: string, reply: CopilotReply) {
    pushUser(userText);
    setThinking(true);
    replyTimer.current = setTimeout(() => {
      setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', text: reply.text, bet: reply.bet, action: reply.action, share: reply.share, link: reply.link }]);
      setThinking(false);
    }, 600);
  }

  // Run an onboarding action from a chat button (create the trading account, or drip
  // test tokens) — the SAME flows the ticket uses. createAccount signs a one-time
  // setup; the grant is a treasury drip. Both need a connected wallet.
  async function handleOnboardAction(kind: OnboardAction['kind']) {
    if (!acct.owner) {
      botAfterBeat(['Tap Connect (top right) to sign in first, then I’ll take care of it.']);
      return;
    }
    if (kind === 'create_account') {
      if (acct.wrapperExists) {
        botAfterBeat(["You've already got a trading account, so you're ready to bet. Say “safe up bet”, or “get test tokens” if you need funds."]);
        return;
      }
      setThinking(true);
      try {
        const digest = await acct.createAccount();
        pushBot(
          digest
            ? ['Your trading account is ready. Nice.', 'Next, say “get test tokens” (or tap the button) and I’ll fund it, then you can place your first bet.']
            : ['That didn’t go through, so your account wasn’t created. You can try again, or set it up from the trade ticket.'],
        );
      } catch {
        pushBot(['That didn’t go through, so your account wasn’t created. You can try again, or set it up from the trade ticket.']);
      } finally {
        setThinking(false);
      }
      return;
    }
    // get_tokens — the treasury drip works ONLY for a brand-new, near-empty wallet.
    // If the wallet already has funds or a trading account, the grant would be
    // rejected, so explain + point to the faucet instead of a doomed attempt.
    if (!grantEligibleFor(acct)) {
      const funds = acct.balanceBase + (acct.walletDusdcBase ?? 0n);
      botAfterBeat([
        funds >= STARTER_GRANT_BALANCE_CEILING
          ? "You've already got enough test tokens to trade, so you're set. Tell me a direction and I’ll set up a bet."
          : !starterGrant.enabled
            ? faucetLine('Auto-funding is off right now.')
            : faucetLine('I can only auto-send test tokens to a brand-new wallet, and yours is already set up.'),
      ]);
      return;
    }
    // Drip the starter grant. Its toast + success modal fire too; the effects below
    // add a chat line on success, and a faucet fallback on failure.
    if (grant.busy) return;
    setThinking(true);
    try {
      await grant.claim();
    } finally {
      setThinking(false);
    }
  }

  // Latest account state readable inside the delayed nudge timer + grant effects.
  // Synced in an effect (not during render) so a timer that fires later sees fresh
  // account state without those effects re-subscribing to every account tick.
  const acctRef = useRef(acct);
  useEffect(() => {
    acctRef.current = acct;
  });

  // Proactive onboarding: a moment after a wallet connects with NO trading account,
  // nudge them to create one (one-tap button). Once per connected wallet; the 2.5s
  // delay lets the account query settle so we don't misfire on a wallet that has an
  // account. Live co-pilot only.
  const nudgeDoneRef = useRef(false);
  useEffect(() => {
    if (!COPILOT_LIVE || !acct.owner) return;
    nudgeDoneRef.current = false; // re-arm for this connected wallet
    const id = setTimeout(() => {
      if (nudgeDoneRef.current) return;
      const a = acctRef.current;
      if (!a.owner || a.wrapperExists) return; // signed out, or already has an account
      nudgeDoneRef.current = true;
      // A brand-new empty wallet needs test tokens first (they also cover gas);
      // a funded-but-account-less wallet just needs the account.
      const eligible = grantEligibleFor(a);
      setMessages((prev) => [
        ...prev,
        {
          id: 'onboard-nudge',
          role: 'assistant',
          text: eligible
            ? [
                "Welcome! You're signed in. To start trading you'll need some free test tokens (they cover gas too) and a one-time trading account.",
                'Want me to grab you some test tokens to get started?',
              ]
            : [
                "Welcome! You're signed in, but you don't have a trading account yet.",
                "It's a one-time, free setup so you can place bets. Want me to create it?",
              ],
          action: eligible ? { kind: 'get_tokens', label: 'Get test tokens' } : { kind: 'create_account', label: 'Create trading account' },
        },
      ]);
    }, 2500);
    return () => clearTimeout(id);
  }, [acct.owner]);

  // Grant success → a chat line (the toast + success modal fire too). Deduped by
  // digest so a re-render can't repeat it.
  const grantMsgRef = useRef<string | null>(null);
  useEffect(() => {
    if (!grant.success || grantMsgRef.current === grant.success.digest) return;
    grantMsgRef.current = grant.success.digest;
    const sui = grant.success.sui > 0 ? ' (plus a little SUI for gas)' : '';
    const funded = acctRef.current.wrapperExists;
    setMessages((prev) => [
      ...prev,
      {
        id: `grant-${grant.success!.digest}`,
        role: 'assistant',
        text: [
          `Done — ${fmtQuote(grant.success!.amount)} test DUSDC is in your wallet${sui}.`,
          funded
            ? 'You’re funded and ready. Tell me a direction and I’ll set up a bet.'
            : 'Now say “create my trading account” (or tap the button) and you’re ready to bet.',
        ],
      },
    ]);
  }, [grant.success]);

  // Grant failure → point to the public faucet (the grant is never a dead end).
  const grantFailRef = useRef(false);
  const grantFailNRef = useRef(0);
  useEffect(() => {
    if (grant.failed && !grantFailRef.current) {
      grantFailRef.current = true;
      setMessages((prev) => [
        ...prev,
        {
          id: `grant-fail-${grantFailNRef.current++}`,
          role: 'assistant',
          text: [
            'I couldn’t send the test tokens automatically right now.',
            predictV2Config.faucetUrl ? `You can grab them from the faucet instead: ${predictV2Config.faucetUrl}` : 'Give it a moment and try again.',
          ],
        },
      ]);
    } else if (!grant.failed) {
      grantFailRef.current = false;
    }
  }, [grant.failed]);

  // Typed "trade it" → place the bet directly (no in-app confirm step) using the
  // SAME budget mint the ticket runs. The "Trade it" BUTTON still opens the ticket
  // for anyone who wants to review first. External wallets still show their own
  // signing prompt (that's the wallet's, and we don't bypass it); gasless (Google)
  // accounts place with no extra tap. Anything that needs the tested ticket UI —
  // first-run account creation, low funds, an expiring market — falls back to
  // opening the ticket so the trader is never left stuck or silently failing.
  async function placeBetDirect(bet: BetSuggestion, userText: string) {
    pushUser(userText);
    // Confirming "trade it" ends the wizard — whether it places directly or hands
    // off to the ticket. Without this the flow stays active and every following
    // question gets swallowed by the wizard (re-showing the review / asking for a
    // strike) instead of being answered normally.
    setFlow(null);
    const now = Date.now();
    const market = markets.find((m) => m.expiry_market_id === bet.marketId);
    const pricer = market ? pricers[bet.marketId] : undefined;
    const st0 = useV2TradeStore.getState();
    const stake = bet.amount ?? st0.stake;
    const leverage = bet.leverage ?? st0.leverage;
    const plan =
      market && pricer
        ? planBinaryBudgetMint({ market, forward: pricer.forward, svi: pricer.svi, strikePrice: bet.strikePrice, isUp: bet.isUp, stake, leverage })
        : null;

    const expired = !market || bet.expiry <= now || isTooCloseToExpiry(market, now);
    const walletKnown = acct.walletDusdcBase !== undefined;
    const fundable = !!plan && walletKnown && plan.maxCost <= acct.balanceBase + (acct.walletDusdcBase ?? 0n);
    const canAutoPlace = !!plan && !expired && plan.probOk && plan.stakeOk && acct.wrapperExists && fundable && !acct.busy;

    if (!canAutoPlace) {
      // Hand off to the ticket to finish (connect / create account / add funds /
      // pick another market), and say why.
      handlePlaceBet(bet);
      const why = !acct.owner
        ? 'connect your wallet and place it there'
        : expired
          ? 'that market’s about to settle — pick a fresh one in the ticket'
          : !acct.wrapperExists
            ? 'let’s set up your trading account in the ticket first'
            : !walletKnown
              ? 'I’m still loading your balance — place it from the ticket'
              : !fundable
                ? 'you’ll need a little more DUSDC — top up and place it from the ticket'
                : 'finish placing it from the ticket';
      setThinking(true);
      replyTimer.current = setTimeout(() => {
        pushBot([`I’ve opened your ticket — ${why}.`]);
        setThinking(false);
      }, 500);
      return;
    }

    applyBet(bet); // light it up on the surface while it lands
    pendingBetRef.current = null;
    const deposit = plan!.maxCost > acct.balanceBase ? plan!.maxCost - acct.balanceBase : undefined;
    setThinking(true);
    try {
      const digest = await acct.mintBudget({ ...plan!.mint, deposit });
      if (digest) {
        pulseFill({ marketId: bet.marketId, strike: plan!.strike, isUp: bet.isUp });
        pushBot([`Done — your ${bet.isUp ? 'UP' : 'DOWN'} $${num(bet.strikePrice, 0)} bet is live. Watch it below, or close it any time.`]);
      } else {
        // It didn't place — keep the bet pending so "trade it" can retry it.
        pendingBetRef.current = bet;
        pushBot(['That didn’t go through, so nothing was placed. Say “trade it” to try again, or open the ticket to place it yourself.']);
      }
    } catch {
      pendingBetRef.current = bet;
      pushBot(['That didn’t go through, so nothing was placed. Say “trade it” to try again, or open the ticket to place it yourself.']);
    } finally {
      setThinking(false);
    }
  }

  // "Which strike has the most volume?" — the surface holds pricing, not volume,
  // so pull the recent bets from the ORDERS feed and bucket them by strike. Scope:
  // 'now' = the single live market, 'all' = every open expiry (capped so the
  // fan-out stays bounded). Lazy + cached (fetchQuery dedupes with the analytics
  // hook), so it costs nothing until asked and repeat asks are cheap.
  async function answerBusiestStrike(scope: 'now' | 'all', userText: string) {
    pushUser(userText);
    setThinking(true);
    try {
      const now = Date.now();
      const open = markets.filter((m) => m.expiry > now).sort((a, b) => a.expiry - b.expiry);
      if (open.length === 0) {
        pushBot(["There's no live market right now — a new one opens about every minute, so check back in a moment."]);
        return;
      }
      const targets = scope === 'now' ? open.slice(0, 1) : open.slice(0, 12);
      const results = await Promise.all(
        targets.map((m) =>
          queryClient
            .fetchQuery({
              queryKey: qkV2.marketOrders(m.expiry_market_id),
              queryFn: () => getMarketOrders(m.expiry_market_id, 60),
              staleTime: 8_000,
            })
            .then((orders) => ({ market: m, orders: (orders as V2OrderEvent[]) ?? [] }))
            .catch(() => ({ market: m, orders: [] as V2OrderEvent[] })),
        ),
      );
      const buckets = aggregateStrikeVolume(results);
      const base = busiestStrikeReply(buckets, { scope, now }).text;
      const top = buckets[0];
      if (top && top.volume > 0) {
        highlightStrike(top); // light the busiest strike up on the surface
        pushBot([base[0], 'I’ve highlighted it on the surface.', ...base.slice(1)]);
      } else {
        pushBot(base);
      }
    } catch {
      pushBot(["I couldn't read the recent bets just now — give it a moment and ask again."]);
    } finally {
      setThinking(false);
    }
  }

  // "Close my up bet / redeem my winnings / cash out the 65k" → close the matching
  // position(s) directly, the same redeem the Portfolio panel runs (external wallets
  // still show their own signing prompt). Ambiguous or not-found falls back to
  // listing what's open so the trader is never stuck.
  async function answerClosePosition(sel: { all?: boolean; winnings?: boolean; dir?: 'up' | 'down'; strike?: number }, userText: string) {
    pushUser(userText);
    if (!acct.owner) {
      botAfterBeat(['Connect your wallet (top-right) and I can close a bet for you.']);
      return;
    }
    // Real, redeemable rows only (a live/settled position with a quantity left).
    const closeable = positionsRef.current.filter((p) => !p.sample && p.marketId && p.orderId != null && (p.qtyBase ?? 0n) > 0n && p.qty > 0);
    if (closeable.length === 0) {
      botAfterBeat(["You don't have any open bets to close right now. Say “set up a trade” whenever you want to place one."]);
      return;
    }
    const match = matchPositionsToClose(closeable, sel);
    if (match.action === 'none') {
      botAfterBeat([
        sel.winnings ? "You don't have any settled winnings to redeem yet." : "I couldn't find a bet matching that. Here's what you have open:",
        ...(sel.winnings ? [] : closeable.map((p) => `• ${positionCloseLabel(p)}`)),
      ]);
      return;
    }
    if (match.action === 'ask') {
      botAfterBeat(['You have a few open — which one?', ...match.positions.map((p) => `• ${positionCloseLabel(p)}`), 'Tell me the side or strike (e.g. “close the up one” or “close the 65k”), or say “close all”.']);
      return;
    }

    setThinking(true);
    try {
      let done = 0;
      let proceeds = 0;
      for (const p of match.positions) {
        const args = { marketId: p.marketId!, orderId: p.orderId!, closeQuantity: p.qtyBase! };
        const digest = p.settled ? await acct.redeemSettled(args, { silentSuccess: true }) : await acct.redeemLive(args, { silentSuccess: true });
        if (digest) {
          done += 1;
          proceeds += winningClaimPayout(p, p.qtyBase!) ?? p.markValue ?? 0;
        }
      }
      if (done === 0) {
        pushBot(['That didn’t go through, so nothing was closed. You can try again, or use the Portfolio panel.']);
      } else if (done === 1) {
        const p = match.positions[0];
        const lost = p.settled && p.won === false;
        const gained = winningClaimPayout(p, p.qtyBase!) ?? p.markValue ?? 0;
        const side = positionCloseLabel(p).split(' · ')[0];
        pushBot([
          lost
            ? `Cleared your ${side} bet — it settled a loss, so there was nothing to redeem.`
            : `Closed your ${side} bet${gained > 0 ? ` — ${'$' + num(gained, 2)} back in your account` : ''}.`,
        ]);
      } else {
        pushBot([`Closed ${done} bets${proceeds > 0 ? ` — about $${num(proceeds, 2)} back in your account` : ''}. Nice.`]);
      }
    } catch {
      pushBot(['That didn’t go through, so nothing was closed. You can try again, or use the Portfolio panel.']);
    } finally {
      setThinking(false);
    }
  }

  // A short "typing" beat, then a bot line — for non-executing answers.
  function botAfterBeat(text: string[]) {
    setThinking(true);
    replyTimer.current = setTimeout(() => {
      pushBot(text);
      setThinking(false);
    }, 500);
  }

  function handleSend(text: string) {
    if (thinking) return; // one at a time (the input is disabled too)
    // Date.now() + the cached spot read in an event handler (not render) — keeps
    // the surface from re-rendering every tick just to hold a live clock/price.
    const now = Date.now();
    const spot = readSpot();
    const candidates = liveCandidates();

    // "Trade it" / "place it" / "yes" once a bet is set up → place it directly (no
    // in-app confirm step), reusing the ticket's exact budget mint. The review
    // card's "Trade it" BUTTON still opens the ticket for anyone who wants to
    // check it first. Only fires when a bet is actually pending.
    if (pendingBetRef.current && isPlaceConfirmation(text)) {
      void placeBetDirect(pendingBetRef.current, text);
      return;
    }

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
      if (intent.kind === 'busiest_strike') {
        // Needs the orders feed (not in the surface's pricing data) — fetch it on
        // demand and answer async, so there's no standing cost when it's not asked.
        void answerBusiestStrike(intent.scope, text);
        return;
      }
      if (intent.kind === 'close_position') {
        // On-chain redeem — handled async against the trader's live positions.
        void answerClosePosition(intent, text);
        return;
      }
      if (intent.kind === 'start_trade') {
        // Pass the raw message so any inline params (strike/amount/leverage/side)
        // pre-fill the wizard and only the missing pieces get asked.
        const res = startFlow({ candidates, now, spot }, text);
        reply = res.reply;
        nextFlow = res.flow;
      } else {
        // Read the store imperatively (getState, not a subscription) for the
        // current selection so "analyse the current strike" reads the ticket's
        // strike without this screen re-rendering on every store change.
        const st = useV2TradeStore.getState();
        const selection = selected ? { marketId: selected.expiry_market_id, strikePrice: st.strikePrice ?? 0, isUp: st.isUp, stake: st.stake, leverage: st.leverage } : null;
        reply = respondToIntent(intent, {
          insights: insights ?? null,
          positioning: positioning ?? null,
          narrative: narrative ?? null,
          candidates,
          now,
          spot,
          wallet: readWallet(),
          surfaceInputs,
          closes: candles?.closes ?? null,
          portfolio: portfolioRef.current,
          selection,
        });
        nextFlow = null;
      }
    }

    // The surface reacts immediately; remember a fresh bet as the one "trade it"
    // will place. A non-bet reply mid-wizard clears it (we're still collecting
    // slots); a plain answer keeps the last suggestion so "trade it" still works.
    if (reply.bet) {
      applyBet(reply.bet);
      pendingBetRef.current = reply.bet;
    } else if (reply.highlight) {
      // "Find me the $X strike" → light it up on the surface (no bet suggested).
      const h = reply.highlight;
      selectMarket(h.marketId);
      setMode('binary');
      setIsUp(h.isUp);
      setStrikePrice(h.strikePrice);
      markPicked();
    } else if (nextFlow) {
      pendingBetRef.current = null;
    }
    setFlow(nextFlow);
    pushExchange(text, reply);
  }

  // Everything the left stage (stat bar + markets rail + surface) needs, bundled
  // once so the live layout and the coming-soon backdrop render the exact same
  // cockpit (no divergence between the teaser and the finished thing).
  const stageProps: StageProps = {
    insights: insights ?? null,
    vol,
    arb,
    bias: lean,
    nextExpiry: nextExp,
    canSurface,
    surfaceInputs,
    markets,
    pricerSeeds,
    serverNow,
  };

  if (markets.length === 0) {
    return <div className="card mx-4 my-8 px-4 py-8 text-center text-[13px] text-text-3">No live markets right now — check back in a moment.</div>;
  }

  // Gated for launch: real (live) surface + a sample chat, blurred behind a
  // "coming soon" overlay. Flip COPILOT_LIVE to take it live.
  if (!COPILOT_LIVE) {
    return <CopilotComingSoon stage={stageProps} />;
  }

  return (
    <>
      <CopilotAutoAdvance markets={markets} serverNow={serverNow} />
      {/* Desktop: lock main to the viewport (flex-none so the explicit height wins
          over flex-1's basis, grid-rows-1 so the single row is 1fr of that fixed
          height) → each column scrolls INTERNALLY instead of growing the page.
          Mobile: normal flow (flex-1), the page scrolls as usual. */}
      <main className="grid flex-1 grid-cols-1 gap-px bg-white/6 lg:h-[calc(100dvh-4rem)] lg:flex-none lg:grid-cols-[minmax(0,1fr)_400px] lg:grid-rows-1 lg:overflow-hidden">
        {/* Left — the cockpit: a live stat bar, a markets rail, and the surface
            (the hero). It reacts to the conversation: a suggested or clicked bet
            lights up here, and you trade it in place (surface click-to-mint) or via
            the pop-out ticket. Hidden on mobile (the chat leads there). */}
        <CopilotStage {...stageProps} />

        {/* Right — the conversation. Bounded height so it scrolls internally. An
            ambient surface read is pinned above the thread; the chips adapt to the
            live market. Once a bet is live it shows at the bottom of the thread
            here (and on the surface as a gem), so the trader can watch it perform
            and close it in place — inside the chat — without leaving for /portfolio. */}
        <aside className="flex min-h-[62vh] min-w-0 flex-col bg-bg-0 lg:min-h-0">
          <CopilotChat
            messages={messages}
            onSend={handleSend}
            onPlaceBet={handlePlaceBet}
            onEditBet={handleEditBet}
            onAction={handleOnboardAction}
            onShare={setShareCard}
            busy={thinking}
            suggestions={chips}
            pinnedTop={<CopilotRead bias={lean} vol={vol} upChance={rows[0]?.upChance ?? null} closes={candles?.closes ?? null} />}
            threadEnd={<CopilotOpenBets summaryRef={portfolioRef} positionsRef={positionsRef} />}
          />
        </aside>
      </main>

      {/* The ticket lives in a modal (all breakpoints) — it pops out only when the
          trader taps "Place this bet" (or a surface pick), so the surface owns the
          page instead of a permanent ticket rail. */}
      <V2CopilotTicketModal market={selected} pricer={pricer} serverNow={serverNow} />

      {/* Starter-grant confirmation — a gasless, popup-less drip is easy to miss on
          a toast alone (mirrors the ticket). */}
      <SuccessModal
        open={!!grant.success}
        onClose={grant.clearSuccess}
        title="Account funded"
        eyebrow="Received"
        amount={grant.success?.amount ?? 0}
        sub="added to your wallet — you’re ready to trade"
        gasNote={grant.success?.sui ? `+ ${grant.success.sui} SUI added for gas` : undefined}
        digest={grant.success?.digest}
      />

      {/* The fear & greed share card — opens when a "Share to X" chip is tapped
          under a fear & greed answer. */}
      <FearGreedShareModal
        open={!!shareCard}
        value={shareCard?.kind === 'fear_greed' ? shareCard.value : null}
        label={shareCard?.kind === 'fear_greed' ? shareCard.label : null}
        onClose={() => setShareCard(null)}
      />
    </>
  );
}

/** Everything the left cockpit needs — bundled so the live layout and the
 *  coming-soon backdrop render the identical stage. */
interface StageProps {
  insights: BtcInsights | null;
  vol: VolState | null;
  arb: ArbState | null;
  bias: Bias | null;
  nextExpiry: number | null;
  canSurface: boolean;
  surfaceInputs: SmileInput[];
  markets: V2Market[];
  pricerSeeds: Record<string, LivePricer>;
  serverNow: number;
}

/**
 * CopilotStage — the left column of the co-pilot page (desktop): a live stat bar
 * docked on top, the surface as the hero, and the oracle table (V2MarketPicker,
 * the SAME table/cards the Trade page uses) underneath it — so the surface reads
 * exactly like the Trade page, with its markets in a table below rather than a
 * side rail. Selecting a market there drives the shared store, so the surface +
 * ticket react. The stat bar is a leaf that owns its own live ticking, so it
 * never re-renders the surface. Hidden on mobile, where the chat leads.
 */
function CopilotStage({ insights, vol, arb, bias, nextExpiry, canSurface, surfaceInputs, markets, pricerSeeds, serverNow }: StageProps) {
  return (
    <section className="hidden min-w-0 flex-col bg-bg-0 lg:flex lg:min-h-0">
      <CopilotStatBar insights={insights} vol={vol} arb={arb} bias={bias} nextExpiry={nextExpiry} serverNow={serverNow} />
      {/* Surface hero on top… */}
      <div className="h-[54vh] min-h-90 shrink-0">
        {canSurface ? (
          <SurfaceMountV2 inputs={surfaceInputs} markets={markets} serverNow={serverNow} />
        ) : (
          <div className="grid h-full place-items-center text-[12px] text-text-3">Building the live surface…</div>
        )}
      </div>
      {/* …the oracle table underneath, scrolling internally (Trade-page layout). */}
      <div className="flex min-h-0 flex-1 flex-col border-t border-line p-4">
        <V2MarketPicker markets={markets} pricerSeeds={pricerSeeds} serverNow={serverNow} />
      </div>
    </section>
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
function CopilotComingSoon({ stage }: { stage: StageProps }) {
  const preview = useMemo(() => previewMessages(stage.serverNow), [stage.serverNow]);
  const noop = () => {};
  return (
    <div className="relative flex-1 overflow-hidden lg:h-[calc(100dvh-4rem)] lg:flex-none">
      {/* The real page, behind glass. `inert` takes the whole subtree out of the
          tab order / hit-testing; the blur + slight scale hide the frosted edges.
          The SAME CopilotStage renders here, so the teaser is the finished cockpit
          (blurred), not a stand-in. Clawby-backed pills self-hide (insights gated
          off), so it still costs no credits behind the gate. */}
      <div inert aria-hidden className="pointer-events-none h-full select-none blur-[6px]">
        <main className="grid h-full grid-cols-1 gap-px bg-white/6 lg:grid-cols-[minmax(0,1fr)_400px] lg:grid-rows-1">
          <CopilotStage {...stage} />
          <aside className="flex min-h-[62vh] min-w-0 flex-col bg-bg-0 lg:min-h-0">
            <CopilotChat
              messages={preview}
              onSend={noop}
              onPlaceBet={noop}
              onEditBet={noop}
              busy={false}
              suggestions={suggestChips({ vol: stage.vol, arb: stage.arb, bias: stage.bias, hasPortfolio: false })}
              pinnedTop={<CopilotRead bias={stage.bias} vol={stage.vol} upChance={null} closes={null} />}
            />
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
 *
 * It also mirrors the current positions roll-up into `summaryRef` (it already has
 * the positions), so the screen can answer "how's my portfolio?" imperatively
 * without subscribing to positions itself — keeping the surface off that path.
 */
function CopilotOpenBets({ summaryRef, positionsRef }: { summaryRef: MutableRefObject<PortfolioSummary | null>; positionsRef: MutableRefObject<V2PortfolioPosition[]> }) {
  const acct = usePredictAccountV2();
  const { positions } = useV2PortfolioPositions(acct.accountId);
  useEffect(() => {
    summaryRef.current = summarizePositions(positions);
    positionsRef.current = positions;
  }, [positions, summaryRef, positionsRef]);
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
