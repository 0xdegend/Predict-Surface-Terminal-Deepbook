'use client';

/**
 * Auto mode: Kelly's setup chat, and the little language helpers that let her
 * acknowledge what she just understood.
 *
 * Split out of autopilot-panel.tsx. See lib/autopilot/read-setup.ts for the reader that
 * feeds it (rules, plus the optional model tier).
 *
 * THE SHAPE. This is a chat and reads like one: a thread of bubbles (Kelly on the left,
 * the trader on the right) in a scrolling box with the composer at its foot, the same
 * language as the co-pilot chat on /v2/copilot. Under the box, four slots say what Kelly
 * has heard so far, so what is still outstanding can be read without scrolling back.
 * A 2026-09-03 pass briefly flattened this to a heading plus "You said", one turn at a
 * time. It read as a form, not a conversation, and was put back the same day.
 */
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { useAutopilotStore, type SetupTurn } from '@/lib/store/autopilot-store';
import { LuArrowRight, LuCircleCheck, LuRotateCcw, LuSparkles } from 'react-icons/lu';
import { MASCOT_SRC } from '@/lib/mascot';
import { num } from '@/lib/format';
import { PRESETS, paceFor, type PresetId } from '@/lib/autopilot/presets';
import { type ResolvedSetup, type SetupGap, type SetupIntent, mergeIntents, missingFrom, resolveSetup, wantsStart } from '@/lib/autopilot/setup-parser';
import { readSetup } from '@/lib/autopilot/read-setup';
import type { StartOutcome } from './shared';

/** What Kelly asks for, in the order she asks. Plain words, one thing at a time. */
const GAP_QUESTION: Record<SetupGap, string> = {
  style: 'How do you want me to play it? Careful, balanced, or bold?',
  budget: 'How much do you want to put in altogether?',
  duration: 'How long should I run for?',
};

/** Tappable answers for the gap currently open, so nobody has to type. */
const GAP_CHIPS: Record<SetupGap, string[]> = {
  style: ['Careful', 'Balanced', 'Bold'],
  budget: ['$10', '$25', '$50', '$100'],
  duration: ['15 minutes', '30 minutes', 'An hour', '2 hours'],
};

/** Kelly's opening line. Drawn, not stored: the thread in the store starts with the
 *  trader's first words, and this is what sits in the box until then. */
const GREETING = "What's the plan today? Tell me how to play it, how much to put in, and how long to run. Leave anything out and I'll ask.";

/** Composer height cap, matching the co-pilot chat: roughly three lines, then scroll. */
const MAX_INPUT_H = 76;

/**
 * Build Kelly's acknowledgement from what the last reply actually taught her. Used when
 * the model is off (or added nothing), so the rule path still speaks like a person
 * instead of going silent. Amounts are always said out loud, never just applied.
 */
function ackFor(before: SetupIntent, after: SetupIntent): string | null {
  const learned: string[] = [];
  if (!before.presetNamed && after.presetNamed) learned.push(presetWord(after.preset));
  if (before.budgetUsd == null && after.budgetUsd != null) learned.push(`$${num(after.budgetUsd, 0)} in total`);
  if (before.durationMins == null && after.durationMins != null) learned.push(durationWords(after.durationMins));
  if (before.perTradeUsd !== after.perTradeUsd && after.perTradeUsd != null) {
    // Cents only when there are cents: "$1,666.67 a bet" for a split budget, "$10 a bet" otherwise.
    learned.push(`$${num(after.perTradeUsd, after.perTradeUsd % 1 === 0 ? 0 : 2)} a bet`);
  }
  if (before.live !== after.live && after.live != null) learned.push(after.live ? 'trading live' : 'watch mode');
  if (after.windows?.length && (before.windows ?? []).join() !== after.windows.join()) {
    learned.push(`${after.windows.map((w) => (w === 'day' ? 'daily' : 'weekly')).join(' and ')} markets too`);
  }
  if (learned.length === 0) return null;
  return `Got it: ${listWords(learned)}.`;
}

/**
 * The paced plan in one breath: "That's up to 5 bets of $100, about 3 minutes apart."
 * The count and gap follow the run length (presets.ts `paceFor`), and a trader who asked
 * for 15 minutes should hear that it means five bets, not three, before they say start.
 * "Up to", because Kelly holds when she reads no good chance.
 */
function planWords(r: ResolvedSetup): string {
  const pace = paceFor(r.preset, { armDurationMs: r.durationMins * 60_000, budgetUsd: r.budgetUsd });
  const per = `$${num(r.perTradeUsd, r.perTradeUsd % 1 === 0 ? 0 : 2)}`;
  if (pace.maxTrades === 1) return `That's one bet of ${per}.`;
  return `That's up to ${pace.maxTrades} bets of ${per}, about ${gapWords(pace.cooldownMs)} apart.`;
}

function gapWords(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} seconds`;
  const m = s / 60;
  return Number.isInteger(m) ? `${m} minute${m === 1 ? '' : 's'}` : `${m.toFixed(1)} minutes`;
}

/**
 * The style's name in the middle of one of Kelly's sentences ("Got it: careful, $25 in
 * total"), and in the STYLE slot. Lowercased off the preset's own name rather than
 * spelled out again here: this used to be a hand-written map, which is how "Careful" in
 * the picker and "cautious" in the chat came to disagree in the first place.
 */
const presetWord = (id: PresetId) => (PRESETS.find((p) => p.id === id)?.name ?? id).toLowerCase();

function durationWords(mins: number): string {
  if (mins < 60) return `${mins} minutes`;
  const h = mins / 60;
  return h === 1 ? 'an hour' : `${h % 1 === 0 ? h : h.toFixed(1)} hours`;
}

function listWords(xs: string[]): string {
  if (xs.length === 1) return xs[0];
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/**
 * KellySetupCard — Auto mode. A conversation, not a one-shot box.
 *
 * It used to be a single input: you typed a sentence, `resolveSetup` quietly filled in
 * anything you had left out from whatever was already in the panel, and it applied. So
 * "go bold" produced a budget the trader never chose, which is exactly what Kelly is
 * not supposed to do.
 *
 * Now the reader (rules, plus the optional model tier) reports what it actually
 * understood, `missingFrom` reports what is still unknown, and Kelly asks for one
 * missing piece at a time with tappable answers. Nothing is applied to the panel until
 * every required piece has been stated by the trader, and nothing runs until they say
 * "start".
 */
export function KellySetupCard({
  current,
  onApply,
  onStart,
  startIssue,
  live,
}: {
  current: { budgetUsd: number; perTradeUsd: number; armDurationMs: number };
  onApply: (r: ResolvedSetup) => void;
  /** Begin the run from the conversation. "start" IS the confirm: the panel arms on the
   *  spot and only opens the start screen when money has to move in first (or a live
   *  blocker needs the wallet). It reports what it did so Kelly can say so. */
  onStart?: () => StartOutcome;
  /** Why starting is blocked right now (the panel's own arm check), so Kelly can say it
   *  in words instead of the trader typing "start" into silence. */
  startIssue?: string | null;
  /** The mode "start" will use, so it is on screen before anyone says the word. */
  live: boolean;
}) {
  // The conversation lives in the store, not here: local state was thrown away every
  // time the trader walked to another tab and back. See SetupChat in the store for why
  // it reads straight from there rather than mirroring into local state.
  const turns = useAutopilotStore((s) => s.setupChat.turns);
  const intent = useAutopilotStore((s) => s.setupChat.intent);
  const push = useAutopilotStore((s) => s.pushSetupTurn);
  const setIntent = useAutopilotStore((s) => s.setSetupIntent);
  const resetChat = useAutopilotStore((s) => s.resetSetupChat);
  // The draft stays local on purpose: a half-typed word is not worth persisting, and
  // restoring one would put words in the box that the trader did not leave there.
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const gaps = missingFrom(intent);
  const openGap = gaps[0] ?? null;
  const done = gaps.length === 0 && turns.length > 0;

  /** Grow the composer with its text, then let it scroll. A single-line input hid the
   *  end of anything longer than the box, which is the wrong trade in the one field on
   *  the page where a trader is asked to write a whole sentence. Same treatment, and the
   *  same cap, as the co-pilot chat's composer. */
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_H)}px`;
  }, [text]);

  /** Keep the newest line in view. A new turn (or the typing dots) lands at the foot of
   *  the thread, so the thread follows it. Set on the thread itself rather than
   *  scrollIntoView, which walks up and scrolls ancestors too, hopping the page. */
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, busy]);

  async function send(raw: string) {
    const message = raw.trim();
    if (!message || busy) return;
    setText('');
    push('trader', message);

    // "start" is a COMMAND, not a description of a run, and it is answered here: before
    // the reader, by a rule, with no model anywhere in the path. Arming spends money, so
    // what triggers it must never depend on what a model made of the sentence.
    //
    // Kelly still refuses on an unfinished setup, which is the same promise she keeps
    // everywhere else in this card: she never supplies a number the trader did not pick,
    // and "start" is not permission to invent the missing ones.
    if (wantsStart(message)) {
      if (gaps.length > 0) {
        push('kelly', `Not yet, there's still one thing I need. ${GAP_QUESTION[gaps[0]]}`);
        return;
      }
      if (startIssue) {
        push('kelly', `I can't start yet: ${lowerFirst(startIssue)}.`);
        return;
      }
      const outcome = onStart?.();
      if (!outcome) return;
      if (outcome.kind === 'started') {
        push(
          'kelly',
          outcome.live
            ? 'Starting now, trading live from your trading account. Stop me any time from the top bar.'
            : "Starting now in watch mode. No real money; I'll score every pick against the real market.",
        );
        return;
      }
      if (outcome.kind === 'signing') {
        push('kelly', "Approve instant trading in your wallet and I'll start.");
        const ok = await outcome.done;
        push(
          'kelly',
          ok
            ? 'Running. Stop me any time from the top bar.'
            : 'That didn’t go through. Check your wallet, then say “start” to try again.',
        );
        return;
      }
      push(
        'kelly',
        outcome.why === 'top_up'
          ? `One thing first: your trading account needs $${num(outcome.topUpUsd, 2)} more to cover the $${num(outcome.budgetUsd, 0)} budget. Confirm the top-up and I'll start.`
          : `One thing first: ${lowerFirst(outcome.issue)}. I've opened the start screen; you can switch to watch mode there.`,
      );
      return;
    }

    setBusy(true);
    try {
      const read = await readSetup({
        message,
        known: {
          style: intent.presetNamed ? intent.preset : undefined,
          budgetUsd: intent.budgetUsd,
          durationMins: intent.durationMins,
          live: intent.live,
        },
        asking: gaps,
      });
      const merged = mergeIntents(intent, read.intent);
      setIntent(merged);

      // Kelly's own line prefers the model's wording, then a rule-built acknowledgement,
      // and only says "I did not catch that" when the reply genuinely taught her nothing.
      const ack = read.note ?? ackFor(intent, merged);
      const nextGaps = missingFrom(merged);
      const resolved = nextGaps.length === 0 ? resolveSetup(merged, current) : null;
      const lines: string[] = [];
      if (ack) lines.push(ack);
      else lines.push("I didn't catch that one.");
      if (!resolved) lines.push(GAP_QUESTION[nextGaps[0]]);
      else lines.push(`${planWords(resolved)} Check the plan, then say “start” whenever you're ready.`);
      push('kelly', lines.join(' '));

      if (resolved) onApply(resolved);
    } finally {
      setBusy(false);
    }
  }

  function restart() {
    resetChat();
    setText('');
  }

  const status = busy ? 'Thinking' : done ? 'Ready when you are' : 'Listening';
  const quick = turns.length > 0 && openGap ? GAP_CHIPS[openGap] : done ? ['Start'] : [];

  return (
    <div className="flex flex-col gap-2.5">
      {/* The chat box: Kelly's bar, the thread, the answers on offer, and the composer.
          A darker well than the card around it, so the bubbles sit IN something. */}
      <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-black/20">
        <div className="flex items-center gap-2.5 border-b border-white/6 px-3 py-2">
          <Image
            src={MASCOT_SRC.thinking}
            alt=""
            width={28}
            height={28}
            aria-hidden
            className="h-7 w-7 flex-none rounded-full bg-(--accent-soft) object-contain ring-1 ring-(--accent-line)"
          />
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-medium leading-tight text-text-1">Kelly</p>
            <p className="mt-0.5 text-[10.5px] leading-tight text-accent">{status}</p>
          </div>
          {turns.length > 0 && (
            <button
              type="button"
              onClick={restart}
              className="glass-inset flex flex-none items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] text-text-2 transition-colors hover:border-(--accent-line) hover:text-text-1"
            >
              <LuRotateCcw size={12} className="flex-none" />
              Start over
            </button>
          )}
        </div>

        {/* The thread. Kelly's greeting is drawn until the trader has said something;
            after that the store's turns are the whole conversation.

            A FIXED height, on purpose. This card sits beside The Plan in a grid row, and
            the row is as tall as the taller card. A thread that grew with the chat (or
            was merely capped) made the Command Center 560-630px tall, and the plan had to
            stretch to match, four short steps pulled apart down a column of gap. The
            thread scrolls, so it can be short: the newest lines stay in view, the plan
            sits at its own compact height, and the two cards share a bottom edge with no
            void in either. */}
        <div ref={threadRef} aria-live="polite" className="scroll-quiet flex h-36 flex-col gap-2 overflow-y-auto px-3 py-3">
          {turns.length === 0 && <Bubble who="kelly" text={GREETING} />}
          {turns.map((t) => (
            <Bubble key={t.id} who={t.who} text={t.text} />
          ))}
          {busy && <TypingBubble />}
        </div>

        {/* Answers to whatever Kelly just asked, or Start once she has everything. */}
        {quick.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pb-2">
            {quick.map((s) => (
              <button
                key={s}
                type="button"
                disabled={busy}
                onClick={() => void send(s)}
                className={`rounded-full px-3 py-1.5 text-[11.5px] transition-colors disabled:opacity-40 ${
                  s === 'Start'
                    ? 'border border-(--accent-line) bg-(--accent-soft) font-medium text-accent hover:bg-up/15'
                    : 'glass-inset text-text-2 hover:border-(--accent-line) hover:text-text-1'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {/* The box you talk to her in. */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(text);
          }}
          className="flex items-end gap-2 border-t border-white/6 px-2.5 py-2"
        >
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter (or a newline mid-IME) drops a line.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(text);
              }
            }}
            disabled={busy}
            rows={1}
            placeholder={openGap && turns.length > 0 ? answerHint(openGap) : 'Tell Kelly what you want to play...'}
            aria-label="Tell Kelly how you want Autopilot to run"
            // 16px is deliberate: iOS Safari force-zooms a focused field under 16px.
            className="scroll-quiet w-full resize-none bg-transparent px-1 py-1 text-[16px] leading-snug text-text-1 outline-none placeholder:text-text-3 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || !text.trim()}
            aria-label="Send"
            className="grid h-9 w-9 flex-none place-items-center rounded-lg border border-(--accent-line) bg-(--accent-soft) text-accent transition-colors hover:bg-up/15 disabled:opacity-40"
          >
            <LuArrowRight size={15} />
          </button>
        </form>
      </div>

      {/* What Kelly has so far. Four slots that fill in as the conversation goes, so the
          trader can see what is still outstanding without scrolling the thread. Mode is
          never a question (it has a default), so it shows the default quietly until it
          is named. */}
      <div className="flex flex-wrap gap-2">
        <Slot label="Style" value={intent.presetNamed ? capital(presetWord(intent.preset)) : null} asking={openGap === 'style'} />
        <Slot label="Budget" value={intent.budgetUsd != null ? `$${num(intent.budgetUsd, 0)}` : null} asking={openGap === 'budget'} />
        <Slot label="Time" value={intent.durationMins != null ? durationWords(intent.durationMins) : null} asking={openGap === 'duration'} />
        <Slot label="Mode" value={live ? 'Live' : 'Watch'} quiet={intent.live == null} />
      </div>

      {done ? (
        <p className="-mt-1 flex items-start gap-1.5 text-[11px] leading-relaxed text-accent">
          <LuCircleCheck size={12} className="mt-px flex-none" />
          Settings loaded. Say &ldquo;start&rdquo; and I&rsquo;ll begin{' '}
          {live ? 'trading live' : 'in watch mode, no real money'}. Say &ldquo;live&rdquo; or &ldquo;watch&rdquo; to switch.
        </p>
      ) : (
        <p className="-mt-1 flex items-start gap-1.5 text-[11px] leading-relaxed text-text-3">
          <LuSparkles size={12} className="mt-px flex-none text-accent" />
          <span>
            Examples: &ldquo;Balanced, $50 for an hour, live&rdquo; or &ldquo;Play it safe for 30 minutes&rdquo;. I&rsquo;ll ask
            about anything you leave out, and I never stake an amount you didn&rsquo;t choose.
          </span>
        </p>
      )}
    </div>
  );
}

/** One line of the thread. Kelly sits left in glass; the trader sits right in the
 *  accent wash. The same two bubbles as the co-pilot chat, so the two Kellys match. */
function Bubble({ who, text }: { who: SetupTurn['who']; text: string }) {
  const mine = who === 'trader';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <p
        className={`max-w-[88%] rounded-2xl px-3 py-1.5 text-[13px] leading-relaxed ${
          mine ? 'rise bg-(--accent-soft) text-text-1' : 'msg-fade glass-inset text-text-2'
        }`}
      >
        {text}
      </p>
    </div>
  );
}

/** Kelly reading the reply: a small name tag and three bouncing dots. */
function TypingBubble() {
  return (
    <div className="flex items-start">
      <div className="glass-inset flex items-center gap-2 rounded-2xl px-3 py-2.5 text-text-3">
        <span className="text-[9.5px] font-medium uppercase tracking-wider">Kelly</span>
        <span className="flex items-center gap-1">
          <span className="typing-dot h-1.5 w-1.5 rounded-full bg-current" />
          <span className="typing-dot h-1.5 w-1.5 rounded-full bg-current" style={{ animationDelay: '0.15s' }} />
          <span className="typing-dot h-1.5 w-1.5 rounded-full bg-current" style={{ animationDelay: '0.3s' }} />
        </span>
      </div>
    </div>
  );
}

/** One "so far" slot: the label, and the value or a question mark while it is unknown. */
function Slot({ label, value, asking = false, quiet = false }: { label: string; value: string | null; asking?: boolean; quiet?: boolean }) {
  const known = value != null && !quiet;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] ring-1 ring-inset transition-colors ${
        known
          ? 'bg-(--accent-soft) text-accent ring-(--accent-line)'
          : asking
            ? 'bg-white/6 text-text-1 ring-white/15'
            : 'bg-white/3 text-text-3 ring-white/8'
      }`}
    >
      {known && <LuCircleCheck size={11} className="flex-none" />}
      <span className="text-[10px] uppercase tracking-wider opacity-70">{label}</span>
      <span className={known ? 'font-medium' : ''}>{value ?? '?'}</span>
    </span>
  );
}

/** Drop a sentence-cased blocker into the middle of one of Kelly's own sentences. */
function lowerFirst(t: string): string {
  return t.charAt(0).toLowerCase() + t.slice(1);
}

function capital(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function answerHint(gap: SetupGap): string {
  if (gap === 'style') return 'Careful, balanced, or bold';
  if (gap === 'budget') return 'An amount, like $25';
  return 'How long, like 30 minutes';
}
