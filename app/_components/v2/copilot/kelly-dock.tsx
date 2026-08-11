'use client';

/**
 * KellyDock — the always-present "Ask Kelly" launcher + right-side chat drawer.
 *
 * Kelly already lives as the whole `/v2/copilot` page (surface cockpit + wizard +
 * ticket). This is the LIGHT, global way in: a floating fox button pinned bottom-
 * right on every screen that opens a slide-in chat, so a trader (especially a
 * newcomer) can ask "what's a call option?", "analyze BTC", or "what's happening
 * today?" from anywhere without leaving the page.
 *
 * It reuses the SAME brain (parseIntent → respondToIntent, plus the Claude long
 * tail) and the SAME chat UI (CopilotChat) as the full page. It is deliberately
 * chat-first: it answers questions and suggests bets. A suggested (or "trade it"-
 * confirmed) bet pops the trade ticket IN PLACE over the drawer — no navigation,
 * wherever the trader opened Kelly — reusing the co-pilot's compact ticket, which
 * they still confirm to sign (Kelly never signs on its own). The heavier money
 * paths (the guided wizard, onboarding, closing a bet) still hand off to the full
 * trade view, which has the surface + step flow.
 *
 * Data (markets/pricers/insights/events/account) mounts ONLY while the drawer is
 * open (the panel is unmounted when closed), so the launcher costs nothing on a
 * page until a user actually opens it.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { LuX } from 'react-icons/lu';
import { MASCOT_SRC } from '@/lib/mascot';
import { fromQuote } from '@/config/scale';
import { CopilotChat, type ChatMessage } from './copilot-chat';
import { CopilotRead } from './copilot-read';
import { V2CopilotTicketModal } from './copilot-ticket-modal';
import { parseIntent, placeConfirmation, type CopilotIntent } from '@/lib/copilot/intents';
import { respondToIntent, type BetCandidate, type BetSuggestion, type CopilotReply } from '@/lib/copilot/respond';
import { marketRows, volState, bias as pulseBias } from '@/lib/copilot/pulse';
import { askKellyAI, type AiContext, type AiTurn } from '@/lib/copilot/ai';
import { eventGreetingLine } from '@/lib/insights/events';
import { useV2Markets } from '@/lib/hooks/use-v2-markets';
import { useV2Pricers } from '@/lib/hooks/use-v2-pricers';
import { useV2Spot } from '@/lib/hooks/use-v2-spot';
import { useNow } from '@/lib/hooks/use-now';
import { useBtcInsights } from '@/lib/hooks/use-btc-insights';
import { useMarketEvents } from '@/lib/hooks/use-market-events';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import type { BtcCandles } from '@/lib/hooks/use-strike-analysis';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';

const COPILOT_LIVE = process.env.NEXT_PUBLIC_COPILOT_LIVE === '1';
const COPILOT_AI = process.env.NEXT_PUBLIC_COPILOT_AI === '1';
const AI_SESSION_CAP = 40;
const AI_TIMEOUT_MS = 16_000;

/** Routes where the dock hides: the full Kelly page (redundant) + the OAuth popup. */
const HIDDEN_ON = ['/v2/copilot', '/auth'];

/** Trade-mutation + onboarding intents the light dock hands off to the full trade
 *  view rather than driving here (the wizard/ticket/positions live on that page). */
const HANDOFF: ReadonlySet<CopilotIntent['kind']> = new Set([
  'create_account', 'get_tokens', 'onboarding', 'close_position', 'adjust_ticket',
]);

// Same greeting as the full /v2/copilot page (copilot-screen.tsx), so the drawer
// reads identically. Today's biggest market event is folded in as a third line
// once the calendar lands (see the effect in KellyPanel).
const GREETING: string[] = [
  "Hi, I'm Kelly, your Predict co-pilot. Tell me which way you think BTC goes and how bold you want to be, and I'll set the bet up for you.",
  'Try “analyze BTC”, “safe up bet”, or say “set up a trade” and I’ll walk you through it step by step.',
];

const DOCK_CHIPS = [
  'How does this work?',
  'What is the surface?',
  'What’s a call option?',
  'Analyze BTC',
  'What’s happening today?',
  'Safe UP bet',
];

// Module-level id counter so message ids stay unique across panel remounts.
let _mid = 0;
const nextId = () => `kd${_mid++}`;

/** The most recent bet Kelly suggested in the thread — the one "trade it" acts on. */
function latestBet(messages: ChatMessage[]): BetSuggestion | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const b = messages[i];
    if (b.role === 'assistant' && b.bet) return b.bet;
  }
  return undefined;
}

function handoffText(kind: CopilotIntent['kind']): string {
  switch (kind) {
    case 'create_account':
      return 'To create your free trading account, open the Trade tab and connect your wallet. I can walk you through it there.';
    case 'get_tokens':
      return 'You can grab free test tokens on the Trade tab once your wallet is connected.';
    case 'onboarding':
      return 'Connect your wallet on the Trade tab to get set up, then I can fund you and place bets.';
    case 'close_position':
      return 'You can close a bet from your open positions on the Portfolio tab.';
    default:
      return 'I can tweak a bet once it’s loaded in the trade view. Open the Trade tab and I’ll set it up.';
  }
}

/* ------------------------------- launcher -------------------------------- */

export function KellyDock() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  // A one-time nudge bubble for first-time visitors, so the button gets noticed.
  const [hint, setHint] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.localStorage.getItem('kelly-dock-seen')) return;
    const t = setTimeout(() => setHint(true), 1400);
    return () => clearTimeout(t);
  }, []);

  if (pathname && HIDDEN_ON.some((p) => pathname.startsWith(p))) return null;

  function openDock() {
    setHint(false);
    try {
      window.localStorage.setItem('kelly-dock-seen', '1');
    } catch {
      /* private mode — the nudge just shows again next time */
    }
    setMessages((m) => (m.length ? m : [{ id: nextId(), role: 'assistant', text: GREETING }]));
    setClosing(false);
    setOpen(true);
  }

  function closeDock() {
    setClosing(true);
    setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 280);
  }

  return (
    <>
      {/* Launcher raised above the mobile bottom-nav pill (lg:hidden); drops to the
          corner on desktop where the nav lives in the header. */}
      {!open && (
        <div className="fixed bottom-24 right-4 z-40 flex items-center gap-2 lg:bottom-6 lg:right-6">
          {hint && (
            <button
              onClick={openDock}
              className="kelly-hint hidden rounded-full border border-line bg-bg-1/90 px-3 py-1.5 text-xs text-text-2 shadow-lg backdrop-blur-sm hover:text-text-1 sm:block"
            >
              Ask Kelly anything
            </button>
          )}
          <button
            aria-label="Ask Kelly"
            onClick={openDock}
            className="kelly-fab group relative flex h-12 w-12 items-center justify-center rounded-full transition-transform hover:scale-105 active:scale-95"
          >
            {/* Breathing glow behind the button (own element, no transform clash). */}
            <span aria-hidden className="kelly-halo absolute -inset-1 rounded-full" />
            {/* Expanding accent ring — the periodic attention pulse. */}
            <span aria-hidden className="kelly-ping absolute inset-0 rounded-full" />
            <span
              aria-hidden
              className="kelly-fab-fox relative h-full w-full rounded-full bg-no-repeat"
              style={{ backgroundImage: `url(${MASCOT_SRC.confident})`, backgroundSize: '150%', backgroundPosition: '50% 24%' }}
            />
          </button>
        </div>
      )}

      {open && (
        <KellyPanel
          closing={closing}
          messages={messages}
          setMessages={setMessages}
          busy={busy}
          setBusy={setBusy}
          onClose={closeDock}
        />
      )}
    </>
  );
}

/* --------------------------------- panel --------------------------------- */

function KellyPanel({
  closing,
  messages,
  setMessages,
  busy,
  setBusy,
  onClose,
}: {
  closing: boolean;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const aiCallsRef = useRef(0);
  // The trade ticket pops IN PLACE over the drawer (its own local flag, not the shared
  // `ticketSheetOpen`), so a confirmed bet never navigates the user out — wherever they
  // opened Kelly, the trade opens right there.
  const [ticketOpen, setTicketOpen] = useState(false);
  const storeMarketId = useV2TradeStore((s) => s.marketId);

  // Live data — mounts only with this panel (i.e. only while the drawer is open).
  const markets = useV2Markets([]);
  const marketIds = markets.map((m) => m.expiry_market_id);
  const pricers = useV2Pricers(marketIds, {}, 8_000);
  const spot = useV2Spot();
  const { data: insights } = useBtcInsights({ enabled: COPILOT_LIVE });
  const { data: events } = useMarketEvents({ enabled: COPILOT_LIVE });
  const acct = usePredictAccountV2();
  // Recent spot path for the ambient read's sparkline + the vol verdict. Shares
  // the ticket's cached key (60s), fetched once — no polling on the surface.
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

  // Slide-in on mount, slide-out when the parent flags `closing`.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, []);

  // Esc closes; lock the page scroll behind the drawer while it's open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // Fold today's biggest scheduled event into the greeting once the calendar
  // lands, but only while the thread is still the base greeting (no chat yet).
  // An effect (not adjust-during-render) since `messages` lives in the parent;
  // guarded on the base line count so a reopen never double-folds.
  useEffect(() => {
    if (!COPILOT_LIVE) return;
    const line = eventGreetingLine(events ?? null);
    if (!line) return;
    setMessages((m) => {
      const only = m.length === 1 ? m[0] : null;
      if (only && only.role === 'assistant' && only.text.length === GREETING.length) {
        return [{ ...only, text: [...only.text, line] }];
      }
      return m;
    });
  }, [events, setMessages]);

  const onScreen = shown && !closing;

  const candidates: BetCandidate[] = markets.flatMap((m) => {
    const p = pricers[m.expiry_market_id];
    return p ? [{ market: m, pricer: p }] : [];
  });

  // Ambient "surface read" pinned above the thread — built from the SAME pulse
  // functions the full page uses (lean + vol verdict + soonest chance-up), so the
  // drawer's read can never contradict it. Renders nothing until there's a lean
  // or a vol read (i.e. nothing in showcase / non-live mode).
  const now = useNow(0);
  const lean = pulseBias(insights ?? null);
  const vol = volState(candidates, candles?.closes, now);
  const upChance = marketRows(candidates, spot, now)[0]?.upChance ?? null;

  const readWallet = () => ({
    connected: !!acct.owner,
    hasAccount: acct.wrapperExists,
    accountBase: acct.balanceBase,
    walletBase: acct.walletDusdcBase,
  });

  function pushUser(text: string) {
    setMessages((m) => [...m, { id: nextId(), role: 'user', text: [text] }]);
  }
  function pushReply(text: string, reply: CopilotReply) {
    setMessages((m) => [
      ...m,
      { id: nextId(), role: 'user', text: [text] },
      // Share cards need their modals (they live on the full page), so drop `share`
      // here to avoid a dead chip; text/bet/link carry over.
      { id: nextId(), role: 'assistant', text: reply.text, bet: reply.bet, link: reply.link },
    ]);
  }

  function readReply(intent: CopilotIntent, now: number): CopilotReply {
    return respondToIntent(intent, {
      insights: insights ?? null,
      positioning: null,
      narrative: null,
      events: events ?? null,
      candidates,
      now,
      spot,
      wallet: readWallet(),
      surfaceInputs: [],
      closes: null,
      portfolio: null,
      record: null,
      selection: null,
    });
  }

  function buildAiContext(): AiContext {
    const soonest = candidates
      .map((c) => c.market.expiry)
      .filter((e) => e > Date.now())
      .sort((a, b) => a - b)[0];
    return {
      spot,
      fearGreed: insights?.sentiment ? { value: insights.sentiment.value, label: insights.sentiment.label } : null,
      nextExpiryMins: soonest ? Math.round((soonest - Date.now()) / 60_000) : null,
      wallet: acct.owner
        ? { connected: true, hasAccount: acct.wrapperExists, balance: fromQuote(acct.balanceBase) + fromQuote(acct.walletDusdcBase ?? 0n) }
        : { connected: false, hasAccount: false, balance: 0 },
    };
  }

  async function answerWithAI(text: string, fallback: CopilotReply) {
    const history: AiTurn[] = messages.slice(-6).map((m) => ({ role: m.role, text: m.text.join(' ') }));
    pushUser(text);
    setBusy(true);
    aiCallsRef.current += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    const showFallback = () =>
      setMessages((m) => [...m, { id: nextId(), role: 'assistant', text: fallback.text, link: fallback.link }]);
    try {
      const reply = await askKellyAI({ message: text, history, context: buildAiContext() }, controller.signal);
      if (reply.available && reply.text?.length) {
        setMessages((m) => [...m, { id: nextId(), role: 'assistant', text: reply.text! }]);
      } else showFallback();
    } catch {
      showFallback();
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  }

  function handleSend(text: string) {
    const t = text.trim();
    if (!t || busy) return;

    // "Trade it" / "trade it with 1 dusdc" / "place it at 2x" → act on the bet Kelly
    // just suggested (with an optional stake/leverage override), instead of starting
    // a fresh trade. Primes the ticket with those exact terms and takes the trader to
    // the trade view to review + sign (the dock never signs).
    const confirm = placeConfirmation(t);
    if (confirm) {
      const base = latestBet(messages);
      if (base) {
        if (base.expiry <= Date.now()) {
          pushReply(t, { text: ['That market just expired, so I can’t place that one. Ask me for a fresh bet and I’ll set it right up.'] });
          return;
        }
        pushUser(t);
        handlePlaceBet({ ...base, amount: confirm.stake ?? base.amount, leverage: confirm.leverage ?? base.leverage });
        return;
      }
      // Nothing suggested yet. A BARE confirm → a nudge; a SIZED confirm ("trade it
      // with 1 dusdc") names real params, so fall through to start a fresh trade.
      if (confirm.stake == null && confirm.leverage == null) {
        pushReply(t, { text: ['Ask me for a bet first and I’ll place it. Try “safe up bet”, or say “set up a trade”.'] });
        return;
      }
    }

    const now = Date.now();
    const intent = parseIntent(t);

    // The guided wizard belongs on the full page (surface + step flow live there).
    if (intent.kind === 'start_trade') {
      pushReply(t, { text: ['Let’s build that in the full trade view, where you can see the live surface. Opening it now.'] });
      onClose();
      router.push('/v2/copilot');
      return;
    }
    // Onboarding + position mutations → a short pointer to where they happen.
    if (HANDOFF.has(intent.kind)) {
      pushReply(t, { text: [handoffText(intent.kind)] });
      return;
    }

    const reply = readReply(intent, now);
    // The Claude read long tail, for questions the rules drop to `help`.
    if (intent.kind === 'help' && COPILOT_AI && aiCallsRef.current < AI_SESSION_CAP) {
      void answerWithAI(t, reply);
      return;
    }
    pushReply(t, reply);
  }

  // A suggested (or "trade it"-confirmed) bet primes the ticket store and pops the ticket
  // IN PLACE over the drawer — no navigation, the drawer stays put. The compact ticket is
  // self-contained (it reads the primed store) and still requires the trader to confirm;
  // Kelly itself never signs. (selectMarket resets the strike, so set it AFTER.)
  function handlePlaceBet(bet: BetSuggestion) {
    const st = useV2TradeStore.getState();
    st.selectMarket(bet.marketId);
    st.setMode('binary');
    st.setIsUp(bet.isUp);
    st.setStrikePrice(bet.strikePrice);
    if (bet.amount != null) st.setStake(bet.amount);
    if (bet.leverage != null) st.setLeverage(bet.leverage);
    setTicketOpen(true);
  }

  // The primed ticket target, matched against the drawer's OWN live markets + pricers
  // (both already mounted while the drawer is open), so the in-place ticket prices live.
  const ticketMarket = markets.find((m) => m.expiry_market_id === storeMarketId) ?? null;
  const ticketPricer = storeMarketId ? pricers[storeMarketId] : undefined;

  return (
    <div className="fixed inset-0 z-50">
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/50 transition-opacity duration-300 ${onScreen ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        role="dialog"
        aria-label="Ask Kelly"
        className={`absolute right-0 top-0 flex h-full w-full flex-col border-l border-line bg-bg-1 shadow-2xl transition-transform duration-300 ease-out sm:w-[400px] lg:w-[420px] ${onScreen ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <header className="flex flex-none items-center gap-3 border-b border-line px-4 py-3">
          <span
            aria-hidden
            className="h-9 w-9 flex-none rounded-full bg-(--accent-soft) bg-no-repeat ring-1 ring-(--accent-line)"
            style={{ backgroundImage: `url(${MASCOT_SRC.confident})`, backgroundSize: '155%', backgroundPosition: '50% 20%' }}
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-text-1">Kelly</p>
            <p className="truncate text-[11px] text-text-3">Your BTC prediction co-pilot</p>
          </div>
          <button
            aria-label="Close"
            onClick={onClose}
            className="flex-none rounded-md p-1.5 text-text-3 transition-colors hover:bg-bg-2 hover:text-text-1"
          >
            <LuX className="h-4.5 w-4.5" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <CopilotChat
            messages={messages}
            onSend={handleSend}
            onPlaceBet={handlePlaceBet}
            onEditBet={() => router.push('/v2/copilot')}
            busy={busy}
            suggestions={DOCK_CHIPS}
            hideHeader
            pinnedTop={<CopilotRead bias={lean} vol={vol} upChance={upChance} closes={candles?.closes ?? null} />}
          />
        </div>
      </div>

      {/* The trade ticket, in place over the drawer. Controlled by our own flag (not the
          shared ticketSheetOpen) so it never double-opens with the trade screen / options
          ticket, and it prices off the drawer's own live markets + pricers. */}
      <V2CopilotTicketModal
        market={ticketMarket}
        pricer={ticketPricer}
        serverNow={now}
        open={ticketOpen}
        onClose={() => setTicketOpen(false)}
      />
    </div>
  );
}
