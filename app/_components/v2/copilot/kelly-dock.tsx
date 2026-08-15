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
 * tail) and the SAME chat UI (CopilotChat) as the full page, and mirrors the full
 * page's trade experience so the two feel identical:
 *   - a TYPED "trade it with 1 dusdc" PLACES the bet directly (placeBetDirect — the
 *     same budget mint the ticket runs), reports it in the chat, and shows it in the
 *     open-bets panel below (DrawerOpenBets) — no modal;
 *   - the "Place this bet" BUTTON pops the compact ticket in place to review first
 *     (the modal is reserved for that explicit click);
 *   - the trader still signs every mint (Kelly never signs on its own; gasless Google
 *     places with no popup, an armed session skips it, an external wallet still prompts).
 * The heavier paths (the guided wizard, onboarding) still hand off to the full trade
 * view, which has the surface + step flow.
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
import { fromQuote, toQuote } from '@/config/scale';
import { CopilotChat, type ChatMessage } from './copilot-chat';
import { CopilotRead } from './copilot-read';
import { V2CopilotTicketModal } from './copilot-ticket-modal';
import { parseIntent, placeConfirmation, type CopilotIntent } from '@/lib/copilot/intents';
import { recallMemories, rememberFact } from '@/lib/copilot/memory-client';
import { welcomeBackLines, MEMORY_GREETING_QUERY, MAX_GREETING_MEMORIES } from '@/lib/copilot/memory-greeting';
import { useKellyMemoryAuth } from '@/lib/hooks/use-kelly-memory-auth';
import { styleNoteForBet, claimAutoRememberSlot } from '@/lib/copilot/auto-memory';
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
import { useV2PortfolioPositions } from '@/lib/hooks/use-v2-portfolio-positions';
import { useV2Leaderboard } from '@/lib/hooks/use-v2-leaderboard';
import { standingFor } from '@/lib/leaderboard/v2';
import type { BtcCandles } from '@/lib/hooks/use-strike-analysis';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { planBinaryBudgetMint } from '@/lib/sui/v2/budget-mint';
import { isTooCloseToExpiry } from '@/lib/markets/v2-discovery';
import { num } from '@/lib/format';
import { V2PositionsPanel } from '../positions-panel';

const COPILOT_LIVE = process.env.NEXT_PUBLIC_COPILOT_LIVE === '1';
const COPILOT_AI = process.env.NEXT_PUBLIC_COPILOT_AI === '1';
// Kelly's Walrus-backed memory (remember/recall). OFF by default — set
// NEXT_PUBLIC_KELLY_MEMORY=1 AND configure the server (WALRUS_DELEGATE_KEY +
// WALRUS_MEMORY_ACCOUNT_ID). Dark otherwise: memory intents fall through to help.
const KELLY_MEMORY = process.env.NEXT_PUBLIC_KELLY_MEMORY === '1';
const AI_SESSION_CAP = 40;
const AI_TIMEOUT_MS = 16_000;

/** Routes where the dock hides: the full Kelly page (redundant) + the OAuth popup. */
const HIDDEN_ON = ['/v2/copilot', '/auth'];

// Proactive help: once a visitor has been on the site this long WITHOUT opening
// Kelly, gently offer a hand ("Do you need some help?"). Session-scoped so it shows
// at most once per visit and never nags on a reload. Tune the delay here.
const HELP_NUDGE_AFTER_MS = 60_000;
const HELP_NUDGE_AUTO_HIDE_MS = 14_000;
const HELP_NUDGE_KEY = 'kelly-help-nudged';

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
  // A gentle "Do you need some help?" bubble once the visitor has lingered a while
  // without opening Kelly (see the dwell effect below). Shows for returning users
  // too, unlike the first-visit `hint`.
  const [helpNudge, setHelpNudge] = useState(false);
  // True once they open Kelly, so the dwell timer never offers help to someone who
  // is already engaged.
  const engagedRef = useRef(false);
  // The live route, read inside the dwell timer's route guard. Synced in an effect,
  // never during render (the refs lint bans render-time ref writes).
  const pathnameRef = useRef(pathname);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.localStorage.getItem('kelly-dock-seen')) return;
    const t = setTimeout(() => setHint(true), 1400);
    return () => clearTimeout(t);
  }, []);

  // Keep the route fresh for the dwell timer's guard below (effect, not render).
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  // Proactive help: once the visitor has been on the site for HELP_NUDGE_AFTER_MS
  // without opening Kelly, pop a "Do you need some help?" bubble — once per visit
  // (session-scoped), and only on a page where the dock actually shows (not the auth
  // popup / full Kelly page). A light poll waits until they're on a visible route,
  // then auto-hides if ignored. KellyDock is a single global mount, so this measures
  // TOTAL time on the site, not per-page.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (window.sessionStorage.getItem(HELP_NUDGE_KEY)) return; // already offered this visit
    } catch {
      /* private mode — fall through; the flag write below is also guarded */
    }
    const start = Date.now();
    let hideT: ReturnType<typeof setTimeout> | undefined;
    const poll = setInterval(() => {
      if (engagedRef.current) {
        clearInterval(poll);
        return;
      }
      if (Date.now() - start < HELP_NUDGE_AFTER_MS) return;
      const onHidden = !!pathnameRef.current && HIDDEN_ON.some((p) => pathnameRef.current!.startsWith(p));
      if (onHidden) return; // wait until they're on a page where the dock shows
      clearInterval(poll);
      try {
        window.sessionStorage.setItem(HELP_NUDGE_KEY, '1');
      } catch {
        /* private mode — it may just offer again next visit */
      }
      setHint(false); // never stack with the first-visit discovery bubble
      setHelpNudge(true);
      hideT = setTimeout(() => setHelpNudge(false), HELP_NUDGE_AUTO_HIDE_MS);
    }, 2_500);
    return () => {
      clearInterval(poll);
      if (hideT) clearTimeout(hideT);
    };
  }, []);

  if (pathname && HIDDEN_ON.some((p) => pathname.startsWith(p))) return null;

  function openDock() {
    engagedRef.current = true; // engaged — the dwell timer won't offer help now
    setHint(false);
    setHelpNudge(false);
    try {
      window.localStorage.setItem('kelly-dock-seen', '1');
      window.sessionStorage.setItem(HELP_NUDGE_KEY, '1'); // no help nudge after they open it
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

  // The "Do you need some help?" bubble dismissed (its ×) — hide it and don't
  // re-offer this visit.
  function dismissHelp() {
    setHelpNudge(false);
    try {
      window.sessionStorage.setItem(HELP_NUDGE_KEY, '1');
    } catch {
      /* private mode */
    }
  }

  return (
    <>
      {/* Launcher raised above the mobile bottom-nav pill (lg:hidden); drops to the
          corner on desktop where the nav lives in the header. */}
      {!open && (
        <div className="fixed bottom-24 right-4 z-40 flex items-center gap-2 lg:bottom-6 lg:right-6">
          {helpNudge ? (
            // Kelly reaching out after the visitor has lingered a while. Accent
            // border so it reads as Kelly speaking; the text opens the chat, the ×
            // dismisses it.
            <div className="kelly-hint flex items-center gap-1 rounded-full border border-(--accent-line) bg-bg-1/95 py-1.5 pr-1 pl-3.5 shadow-lg backdrop-blur-sm">
              <button onClick={openDock} className="text-xs font-medium whitespace-nowrap text-text-1 hover:text-text-1">
                Do you need some help?
              </button>
              <button
                aria-label="Dismiss"
                onClick={dismissHelp}
                className="flex-none rounded-full p-1 text-text-3 transition-colors hover:bg-bg-2 hover:text-text-1"
              >
                <LuX className="h-3 w-3" />
              </button>
            </div>
          ) : hint ? (
            <button
              onClick={openDock}
              className="kelly-hint hidden rounded-full border border-line bg-bg-1/90 px-3 py-1.5 text-xs text-text-2 shadow-lg backdrop-blur-sm hover:text-text-1 sm:block"
            >
              Ask Kelly anything
            </button>
          ) : null}
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
  // Kelly's memory sign-in gate (see copilot-screen.tsx). `signedIn` = the connected wallet
  // holds a valid session; `ensureSignedIn()` mints one with a single signature. Passive
  // continuity + auto-remember act only when already signed in; explicit "remember …" prompts.
  const memoryAuth = useKellyMemoryAuth();
  // The Season-2 board, for "how am I doing on the leaderboard / what should I
  // improve". Mounts only while the drawer is open (like the rest of this panel);
  // on 8-06 it's a single cached fetch. Used only to fold the connected wallet's
  // own standing into the answer at send time.
  const { rows: leaderboardRows } = useV2Leaderboard();
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

  // Passive continuity: when a RETURNING trader opens the drawer, Kelly recalls what it has
  // saved about them and follows the greeting with it. Only when they're ALREADY signed in to
  // memory (a valid session cookie) — we never prompt a signature just to greet. Once per
  // connected wallet, and only while the thread is still fresh (no user turn yet), so it never
  // barges into a chat already underway. Fails soft (no saved notes / a hiccup just leaves the
  // plain greeting). Memory flag only — the dock is interactive regardless of COPILOT_LIVE.
  const welcomedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!KELLY_MEMORY || !memoryAuth.signedIn) return;
    const owner = acct.owner;
    if (!owner || welcomedForRef.current === owner) return;
    welcomedForRef.current = owner;
    let cancelled = false;
    void (async () => {
      const mems = await recallMemories(owner, MEMORY_GREETING_QUERY, MAX_GREETING_MEMORIES);
      if (cancelled) return;
      const lines = welcomeBackLines(mems);
      if (lines.length === 0) return;
      setMessages((m) => {
        if (m.some((x) => x.role === 'user' || x.id === 'welcome-back')) return m;
        return [...m, { id: 'welcome-back', role: 'assistant', text: lines }];
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [acct.owner, memoryAuth.signedIn, setMessages]);

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
      // here to avoid a dead chip; text/bet/link + the vault-deposit card carry over.
      { id: nextId(), role: 'assistant', text: reply.text, bet: reply.bet, link: reply.link, vaultDeposit: reply.vaultDeposit },
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
      leaderboard: standingFor(leaderboardRows, acct.owner),
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

  // Kelly's Walrus-backed memory, from the global dock. Same behavior as the full page,
  // handled inline (no surface needed). The delegate key is server-only, so this calls the
  // memory API; it fails soft so a hiccup never breaks the drawer.
  async function answerMemory(intent: CopilotIntent, userText: string) {
    pushUser(userText);
    const owner = acct.owner;
    if (!owner) {
      pushBot(['Connect your wallet (top-right) and I can remember things for you.']);
      return;
    }
    setBusy(true);
    try {
      const ok = await memoryAuth.ensureSignedIn();
      if (!ok) {
        pushBot(
          !memoryAuth.configured
            ? ["My memory isn't switched on here yet, so I can't save that. Everything else still works."]
            : ['To use memory I need a quick one-time signature so I know it’s really you. It doesn’t move any funds. Approve it in your wallet, then ask me again.'],
        );
        return;
      }
      if (intent.kind === 'recall_memory') {
        const mems = await recallMemories(owner, MEMORY_GREETING_QUERY, 8);
        pushBot(
          mems.length === 0
            ? ["I don't have anything saved about you yet. Tell me a preference like “remember I prefer safer up bets” and I'll keep it."]
            : ['Here’s what I remember about you:', ...mems.map((m) => `• ${m}`)],
        );
      } else if (intent.kind === 'remember') {
        const fact = intent.text ?? '';
        if (!fact) {
          pushBot(['What should I remember? Try “remember I prefer safer up bets”.']);
        } else {
          const saved = await rememberFact(owner, fact);
          pushBot(saved ? ['Got it. I’ll remember that.'] : ["I couldn't save that just now — give it a moment and try again."]);
        }
      }
    } catch {
      pushBot(["I couldn't reach your memory just now — give it a moment and ask again."]);
    } finally {
      setBusy(false);
    }
  }

  // Auto-remember: quietly record the trader's revealed style after a bet they place through
  // the dock, so passive continuity has something real to greet them with. Once per session
  // per wallet, and ONLY when already signed in to memory (never prompts mid-trade). Fire-and-
  // forget. Mirrors the full page. See lib/copilot/auto-memory.ts.
  function autoRememberBetStyle(bet: BetSuggestion) {
    const owner = acct.owner;
    if (!KELLY_MEMORY || !owner || !memoryAuth.signedIn) return;
    if (!claimAutoRememberSlot(owner)) return;
    void rememberFact(owner, styleNoteForBet(bet));
  }

  function handleSend(text: string) {
    const t = text.trim();
    if (!t || busy) return;

    // "Trade it" / "trade it with 1 dusdc" / "place it at 2x" → PLACE the bet Kelly just
    // suggested directly (with an optional stake/leverage override), then show it in the
    // open-bets panel below — no modal (that's reserved for the "Place this bet" button).
    const confirm = placeConfirmation(t);
    if (confirm) {
      const base = latestBet(messages);
      if (base) {
        if (base.expiry <= now) {
          // That market expired while they were reading. Don't dead-end or send them
          // off to the full page: set up a FRESH same-side, same-conviction bet
          // carrying the size they asked for, show it right here in the drawer, and
          // make it the new "trade it" target so they can place a live one in place.
          pushUser(t);
          const stake = confirm.stake ?? base.amount;
          const leverage = confirm.leverage ?? base.leverage;
          const fresh = readReply(
            { kind: 'directional_bet', dir: base.isUp ? 'up' : 'down', conviction: base.conviction, horizon: 'soonest' },
            now,
          );
          if (fresh.bet) {
            const sized: BetSuggestion = { ...fresh.bet, amount: stake ?? fresh.bet.amount, leverage: leverage ?? fresh.bet.leverage };
            const amt = sized.amount;
            const stakeStr = amt == null ? '' : ` with your ${Number.isInteger(amt) ? amt : amt.toFixed(2)} DUSDC`;
            setMessages((m) => [
              ...m,
              {
                id: nextId(),
                role: 'assistant',
                text: [`That one just expired, so here’s a fresh ${base.isUp ? 'UP' : 'DOWN'} bet${stakeStr}. Say “trade it” to place it.`],
                bet: sized,
              },
            ]);
          } else {
            pushBot(["That one just expired, and I couldn’t find a fresh market this second. Give it a moment and ask me for a bet."]);
          }
          return;
        }
        pushUser(t);
        void placeBetDirect({ ...base, amount: confirm.stake ?? base.amount, leverage: confirm.leverage ?? base.leverage });
        return;
      }
      // Nothing suggested yet. A BARE confirm → a nudge; a SIZED confirm ("trade it
      // with 1 dusdc") names real params, so fall through to start a fresh trade.
      if (confirm.stake == null && confirm.leverage == null) {
        pushReply(t, { text: ['Ask me for a bet first and I’ll place it. Try “safe up bet”, or say “set up a trade”.'] });
        return;
      }
    }

    // `now` = the panel's live wall-clock (useNow); read here, not a fresh Date.now(),
    // so this handler stays a pure read (the purity lint bans Date.now() in render-
    // reachable code). Up to ~1s stale is fine for a market read; placeBetDirect re-checks
    // expiry with a fresh clock at mint time.
    const intent = parseIntent(t);

    // Kelly's memory (Walrus) — handled inline here, no surface needed.
    if (KELLY_MEMORY && (intent.kind === 'remember' || intent.kind === 'recall_memory')) {
      void answerMemory(intent, t);
      return;
    }

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

  function pushBot(text: string[]) {
    setMessages((m) => [...m, { id: nextId(), role: 'assistant', text }]);
  }

  // Load a bet into the shared ticket store (surface selection + amount/leverage), the
  // one place both the direct-place and the modal read from. (selectMarket resets the
  // strike, so set it AFTER.)
  function primeStore(bet: BetSuggestion) {
    const st = useV2TradeStore.getState();
    st.selectMarket(bet.marketId);
    st.setMode('binary');
    st.setIsUp(bet.isUp);
    st.setStrikePrice(bet.strikePrice);
    if (bet.amount != null) st.setStake(bet.amount);
    if (bet.leverage != null) st.setLeverage(bet.leverage);
  }

  // The "Place this bet" BUTTON → pop the ticket IN PLACE over the drawer to review first
  // (the modal is reserved for this explicit click). No navigation; the trader confirms
  // there. A TYPED "trade it with 1 dusdc" instead places directly (placeBetDirect below).
  function handlePlaceBet(bet: BetSuggestion) {
    primeStore(bet);
    setTicketOpen(true);
  }

  // Typed "trade it (with 1 dusdc)" → place the bet DIRECTLY (no modal), the SAME budget
  // mint the ticket runs, then report it in the chat and show it in the open-bets panel
  // below — the drawer mirror of the full page's placeBetDirect. Anything that needs the
  // ticket UI (no account, low funds, an expiring market) falls back to opening the modal
  // so the trader is never stuck. Google (gasless) places with no popup; an external
  // wallet still shows its own signing prompt (never bypassed); an armed session skips it.
  async function placeBetDirect(bet: BetSuggestion) {
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
      // Hand off to the ticket to finish (connect / create account / add funds / pick a
      // fresh market), and say why.
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
      pushBot([`I’ve opened your ticket — ${why}.`]);
      return;
    }

    primeStore(bet);
    setBusy(true);
    try {
      const deposit = plan!.maxCost > acct.balanceBase ? plan!.maxCost - acct.balanceBase : undefined;
      const digest = await acct.mintBudget({ ...plan!.mint, deposit });
      if (digest) {
        pushBot([`Done — your ${bet.isUp ? 'UP' : 'DOWN'} $${num(bet.strikePrice, 0)} bet is live. Watch it below, or close it any time.`]);
        autoRememberBetStyle(bet);
      } else {
        pushBot(['That didn’t go through, so nothing was placed. Say “trade it” to try again, or tap Place this bet to do it from the ticket.']);
      }
    } catch {
      pushBot(['That didn’t go through, so nothing was placed. Say “trade it” to try again, or tap Place this bet to do it from the ticket.']);
    } finally {
      setBusy(false);
    }
  }

  // Confirm a vault deposit from a chat card → queue DUSDC into the async LP, the SAME
  // flow the Vault panel runs (acct.requestSupply, topping up from the wallet in the
  // same tx when the trading account is short). Kelly proposed it; this is the trader's
  // tap signing it. A missing account is handed off to the Trade tab (like onboarding).
  async function handleVaultDeposit(amount: number) {
    if (!acct.owner) {
      pushBot(['Tap Connect (top right) to sign in first, then I’ll add it to the vault for you.']);
      return;
    }
    if (!acct.wrapperExists) {
      pushBot(['You’ll need a trading account first. Open the Trade tab to set it up, then I can add to the vault for you.']);
      return;
    }
    if (!(amount > 0)) return;
    const amt = toQuote(amount);
    const spendable = acct.balanceBase + (acct.walletDusdcBase ?? 0n);
    if (amt > spendable) {
      pushBot([`That’s more than you have available right now (${num(fromQuote(spendable), 2)} DUSDC across your account and wallet). Try a smaller amount.`]);
      return;
    }
    const shortfall = amt > acct.balanceBase ? amt - acct.balanceBase : 0n;
    setBusy(true);
    try {
      const digest = await acct.requestSupply(amt, shortfall > 0n ? shortfall : undefined);
      pushBot(
        digest
          ? [
              `Done. Your ${Number.isInteger(amount) ? amount : amount.toFixed(2)} DUSDC is queued into the vault and starts earning at the next vault update.`,
              'You can track it or cancel it any time from the Vault page.',
            ]
          : ['That didn’t go through, so nothing was added to the vault. You can try again, or do it from the Vault page.'],
      );
    } catch {
      pushBot(['That didn’t go through, so nothing was added to the vault. You can try again, or do it from the Vault page.']);
    } finally {
      setBusy(false);
    }
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
            onVaultDeposit={handleVaultDeposit}
            busy={busy}
            suggestions={DOCK_CHIPS}
            hideHeader
            pinnedTop={<CopilotRead bias={lean} vol={vol} upChance={upChance} closes={candles?.closes ?? null} />}
            threadEnd={<DrawerOpenBets />}
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

/**
 * DrawerOpenBets — the trader's live open bets at the BOTTOM OF THE DRAWER THREAD, so a
 * bet placed via "trade it" shows up right there to watch + close, without leaving the
 * drawer. Same panel + redeem dialog the Trade rail / Portfolio / full Kelly page use, so
 * the flows never drift. `useV2PortfolioPositions` is TanStack-deduped, and it renders
 * nothing until there's an open bet, so it costs nothing on an empty thread.
 */
function DrawerOpenBets() {
  const acct = usePredictAccountV2();
  const { positions } = useV2PortfolioPositions(acct.accountId, acct.owner);
  if (!positions.some((p) => p.qty > 0)) return null;
  return (
    <div className="mt-1 border-t border-line pt-3.5">
      <V2PositionsPanel />
    </div>
  );
}
