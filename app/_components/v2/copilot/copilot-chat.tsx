'use client';

/**
 * CopilotChat — the conversation rail for /v2/copilot. Presentational: it renders
 * the message thread, the suggested-prompt chips, and the input, and calls
 * `onSend` with the raw text. All the brains (parse → respond → load the ticket)
 * live in the screen; this file just shows the talk.
 *
 * An assistant message may carry a `bet` (a concrete suggestion the screen has
 * already loaded into the ticket + highlighted on the surface) → it renders a
 * BetCard so the trader sees the exact bet, then reviews and places it in the
 * ticket. Nothing here signs or mints.
 */
import { useEffect, useRef, useState } from 'react';
import { LuSparkles, LuArrowUp, LuTrendingUp, LuTrendingDown, LuClock } from 'react-icons/lu';
import { num, pct } from '@/lib/format';
import { useNow } from '@/lib/hooks/use-now';
import { useV2Spot } from '@/lib/hooks/use-v2-spot';
import type { BetSuggestion } from '@/lib/copilot/respond';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string[];
  bet?: BetSuggestion;
}

const CHIPS = ['Set up a trade', 'Analyze BTC', 'Next market', 'Safe UP bet', 'Longshot UP bet', 'Safe DOWN bet'];

/** Live countdown clock: `6:47`, `0:52`, or `1:02:33` for longer-dated markets. */
function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function CopilotChat({
  messages,
  onSend,
  onPlaceBet,
  onEditBet,
  busy,
}: {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onPlaceBet: (bet: BetSuggestion) => void;
  onEditBet: () => void;
  busy?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  // Keep the newest message (or the typing bubble) in view as the thread grows.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, busy]);

  function submit(text: string) {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setDraft('');
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header */}
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-(--accent-soft) text-accent">
          <LuSparkles size={13} />
        </span>
        <div className="flex flex-col">
          <h2 className="text-[12.5px] font-semibold tracking-tight text-text-1">Predict co-pilot</h2>
          <span className="text-[9.5px] uppercase tracking-wider text-text-3">Auto · beta · grounded in live data</span>
        </div>
      </div>

      {/* thread */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto scroll-quiet px-4 py-4">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} onPlaceBet={onPlaceBet} onEditBet={onEditBet} />
        ))}
        {busy && <TypingBubble />}
        <div ref={endRef} />
      </div>

      {/* chips + input */}
      <div className="border-t border-line px-3 py-3">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {CHIPS.map((c) => (
            <button
              key={c}
              type="button"
              disabled={busy}
              onClick={() => submit(c)}
              className="rounded-full border border-line px-2.5 py-1 text-[10.5px] text-text-2 transition-colors hover:border-accent/40 hover:text-text-1 disabled:opacity-50"
            >
              {c}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(draft);
          }}
          className="flex items-center gap-2 rounded-xl border border-line bg-white/2 px-3 py-1.5 focus-within:border-accent/40"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
            placeholder="Ask, or say “safe up bet”…"
            aria-label="Message the co-pilot"
            className="min-w-0 flex-1 bg-transparent py-1 text-[12.5px] text-text-1 placeholder:text-text-3 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            aria-label="Send"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-(--accent-soft) text-accent transition-colors hover:bg-up/15 disabled:opacity-40"
          >
            <LuArrowUp size={15} />
          </button>
        </form>
      </div>
    </div>
  );
}

/** ms between successive lines revealing — sets the "typing out" pace. */
const LINE_DELAY = 110;

function MessageBubble({
  message,
  onPlaceBet,
  onEditBet,
}: {
  message: ChatMessage;
  onPlaceBet: (bet: BetSuggestion) => void;
  onEditBet: () => void;
}) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex flex-col gap-1.5 ${isUser ? 'items-end' : 'items-start'}`}>
      {/* User bubble rises in as a whole; the assistant bubble only fades (so its
          background never fights the lines that rise in staggered on top). */}
      <div
        className={`max-w-[88%] rounded-2xl px-3 py-2 text-[12.5px] leading-relaxed ${
          isUser ? 'rise bg-(--accent-soft) text-text-1' : 'msg-fade glass-inset text-text-2'
        }`}
      >
        {message.text.map((line, i) => (
          <p
            key={i}
            className={`${i > 0 ? 'mt-1.5' : ''} ${isUser ? '' : 'msg-line'}`}
            style={isUser ? undefined : { animationDelay: `${i * LINE_DELAY}ms` }}
          >
            {line}
          </p>
        ))}
      </div>
      {/* The bet card lands after the last line has typed in. */}
      {message.bet && (
        <div className="rise w-full" style={{ animationDelay: `${message.text.length * LINE_DELAY + 80}ms` }}>
          <BetCard bet={message.bet} onPlace={() => onPlaceBet(message.bet!)} onEdit={onEditBet} />
        </div>
      )}
    </div>
  );
}

/** Three bouncing dots — the "co-pilot is reading the market" beat before a reply. */
function TypingBubble() {
  return (
    <div className="flex items-start">
      <div className="glass-inset flex items-center gap-1 rounded-2xl px-3 py-3 text-text-3">
        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-current" />
        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-current" style={{ animationDelay: '0.15s' }} />
        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-current" style={{ animationDelay: '0.3s' }} />
      </div>
    </div>
  );
}

function BetCard({ bet, onPlace, onEdit }: { bet: BetSuggestion; onPlace: () => void; onEdit: () => void }) {
  const now = useNow(0); // ticks each second → live countdown + flips to "expired"
  const spot = useV2Spot(); // live BTC price (shared query, no extra fetch)
  const remaining = bet.expiry - now;
  const expired = remaining <= 0;
  // A "review" card comes from the guided wizard — it has a chosen stake +
  // leverage, so it shows those and offers Trade it / Edit (vs one-shot Place).
  const review = bet.amount != null && bet.leverage != null;
  const up = bet.isUp;
  const dirColor = up ? 'var(--up)' : 'var(--down)';
  const convictionLabel = bet.conviction === 'safe' ? 'Safer' : bet.conviction === 'longshot' ? 'Longshot' : 'Even odds';
  return (
    <div className={`glass-card w-[88%] overflow-hidden p-3 ${expired ? 'opacity-60' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-mono text-[12px] font-semibold" style={{ color: dirColor }}>
          {up ? <LuTrendingUp size={14} /> : <LuTrendingDown size={14} />}
          {up ? 'UP' : 'DOWN'}
        </span>
        <span
          className="rounded-full px-2 py-0.5 text-[9px] font-medium uppercase tracking-wider"
          style={{ color: dirColor, background: `color-mix(in srgb, ${dirColor} 14%, transparent)` }}
        >
          {convictionLabel}
        </span>
      </div>

      <p className="mt-2 text-[11.5px] leading-snug text-text-2">
        Wins if BTC is {up ? 'above' : 'below'}{' '}
        <span className="font-mono text-text-1">${num(bet.strikePrice, 0)}</span> when it settles.
      </p>
      {spot != null && (
        <p className="mt-1 text-[10.5px] text-text-3">
          BTC is <span className="font-mono text-text-2">${num(spot, 0)}</span> right now
          {!expired && <> · {up ? spot >= bet.strikePrice ? 'above your strike' : `${num(bet.strikePrice - spot, 0)} to go` : spot <= bet.strikePrice ? 'below your strike' : `${num(spot - bet.strikePrice, 0)} to go`}</>}.
        </p>
      )}

      <div className="mt-2.5 grid grid-cols-3 gap-2 border-t border-line pt-2.5 font-mono tabular-nums">
        <Stat label="Odds">{pct(bet.prob, 0)}</Stat>
        <Stat label="Pays">{bet.payoutMult.toFixed(2)}×</Stat>
        <Stat label={expired ? 'Status' : 'Time left'}>
          {expired ? (
            <span className="text-down">Expired</span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <LuClock size={10} />
              {fmtCountdown(remaining)}
            </span>
          )}
        </Stat>
      </div>

      {review && !expired && (
        <p className="mt-2 text-[10.5px] leading-snug text-text-2">
          Betting <span className="font-mono text-text-1">${num(bet.amount!, 0)}</span> at{' '}
          <span className="font-mono text-text-1">{num(bet.leverage!, 1)}×</span> — could win{' '}
          <span className="font-mono text-up">~${num(bet.amount! * bet.payoutMult, 0)}</span>.
        </p>
      )}

      {expired ? (
        <p className="mt-2.5 text-[10.5px] text-text-3">
          This market has expired — {review ? 'start a new one with “set up a trade”.' : 'ask me for a fresh one.'}
        </p>
      ) : review ? (
        <div className="mt-2.5 flex gap-2">
          <button
            type="button"
            onClick={onPlace}
            className="flex-1 rounded-lg border border-(--accent-line) bg-(--accent-soft) py-2 text-[11.5px] font-medium text-accent transition-colors hover:bg-up/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Trade it →
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="rounded-lg border border-line px-3 py-2 text-[11.5px] text-text-2 transition-colors hover:bg-white/5 hover:text-text-1"
          >
            Edit
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onPlace}
          className="mt-2.5 w-full rounded-lg border border-(--accent-line) bg-(--accent-soft) py-2 text-[11.5px] font-medium text-accent transition-colors hover:bg-up/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          Place this bet →
        </button>
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[8.5px] uppercase tracking-wider text-text-3">{label}</span>
      <span className="text-[12px] text-text-1">{children}</span>
    </div>
  );
}
