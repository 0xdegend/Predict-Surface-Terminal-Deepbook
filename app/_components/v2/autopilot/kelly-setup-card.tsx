'use client';

/**
 * Auto mode: Kelly's setup conversation, and the little language helpers that let her
 * acknowledge what she just understood.
 *
 * Split out of autopilot-panel.tsx. See lib/autopilot/read-setup.ts for the reader that
 * feeds it (rules, plus the optional model tier).
 *
 * THE SHAPE (redesign, 2026-09-03). This used to be a chat: a scrolling thread of bubbles
 * with a composer under it. It is now the body of the Command Center and reads top to
 * bottom as one conversation turn at a time: Kelly's current line as the heading (her
 * question, or her acknowledgement), what she has heard so far as four slots, three
 * one-tap plans plus a door to the manual controls, and the box you talk to her in. The
 * whole thread still lives in the store (Kelly's replies are built from it), only the
 * scrollback is gone: the slots say what she knows and the heading says what she wants,
 * which is what the scrollback was for.
 */
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { useAutopilotStore } from '@/lib/store/autopilot-store';
import { LuArrowRight, LuCircleCheck, LuRotateCcw, LuSparkles } from 'react-icons/lu';
import { MASCOT_SRC } from '@/lib/mascot';
import { num } from '@/lib/format';
import { PRESETS, type PresetId } from '@/lib/autopilot/presets';
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
  if (learned.length === 0) return null;
  return `Got it: ${listWords(learned)}.`;
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

  const gaps = missingFrom(intent);
  const openGap = gaps[0] ?? null;
  const done = gaps.length === 0 && turns.length > 0;

  // Kelly's current line is the heading, and the trader's last words sit under it, so
  // the exchange that matters is on screen without a scrollback.
  const lastKelly = [...turns].reverse().find((t) => t.who === 'kelly')?.text ?? null;
  const lastTrader = [...turns].reverse().find((t) => t.who === 'trader')?.text ?? null;

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
      const lines: string[] = [];
      if (ack) lines.push(ack);
      else lines.push("I didn't catch that one.");
      if (nextGaps.length > 0) lines.push(GAP_QUESTION[nextGaps[0]]);
      else lines.push("That's everything. Check the plan, then say “start” whenever you're ready.");
      push('kelly', lines.join(' '));

      if (nextGaps.length === 0) onApply(resolveSetup(merged, current));
    } finally {
      setBusy(false);
    }
  }

  function restart() {
    resetChat();
    setText('');
  }

  const eyebrow = busy ? 'Kelly is thinking' : done ? 'Ready when you are' : 'Kelly is listening';
  const heading = lastKelly ?? "What's the plan today?";
  const quick = turns.length > 0 && openGap ? GAP_CHIPS[openGap] : done ? ['Start'] : [];

  return (
    <div className="flex flex-col gap-4">
      {/* Kelly, and her current line. */}
      <div className="flex items-start gap-4">
        <Image
          src={MASCOT_SRC.thinking}
          alt=""
          width={48}
          height={48}
          aria-hidden
          className="h-12 w-12 flex-none rounded-full object-contain"
        />
        <div className="min-w-0 flex-1">
          <p className="eyebrow flex items-center gap-2 text-accent">
            {eyebrow}
            {busy && (
              <span className="inline-flex gap-1">
                <Dot delay={0} />
                <Dot delay={120} />
                <Dot delay={240} />
              </span>
            )}
          </p>
          <p className="mt-1 text-[17px] font-medium leading-snug text-text-1 sm:text-[19px]">{heading}</p>
          {lastTrader && (
            <p className="mt-1 truncate text-[12px] text-text-3">
              You said: &ldquo;{lastTrader}&rdquo;
            </p>
          )}
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

      {/* What Kelly has so far. Four slots that fill in as the conversation goes, so the
          trader can see what is still outstanding without a scrollback. Mode is never a
          question (it has a default), so it shows the default quietly until it is named. */}
      <div className="flex flex-wrap gap-2">
        <Slot label="Style" value={intent.presetNamed ? capital(presetWord(intent.preset)) : null} asking={openGap === 'style'} />
        <Slot label="Budget" value={intent.budgetUsd != null ? `$${num(intent.budgetUsd, 0)}` : null} asking={openGap === 'budget'} />
        <Slot label="Time" value={intent.durationMins != null ? durationWords(intent.durationMins) : null} asking={openGap === 'duration'} />
        <Slot label="Mode" value={live ? 'Live' : 'Watch'} quiet={intent.live == null} />
      </div>

      {/* The box you talk to her in. Styles are not offered as cards here on purpose:
          this side is for saying it in words, and the Manual tab beside is the one with
          the pickers. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
        className="flex items-end gap-2"
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
          className="scroll-quiet glass-inset w-full resize-none rounded-xl px-3.5 py-3 text-[16px] leading-snug text-text-1 outline-none transition-colors placeholder:text-text-3 focus:border-(--accent-line) disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          aria-label="Send"
          className="flex h-11 w-11 flex-none items-center justify-center rounded-xl border border-(--accent-line) bg-(--accent-soft) text-accent transition-colors hover:bg-up/15 disabled:opacity-40"
        >
          <LuArrowRight size={16} />
        </button>
      </form>

      {/* Answers to whatever Kelly just asked, or Start once she has everything. */}
      {quick.length > 0 && (
        <div className="-mt-2 flex flex-wrap gap-1.5">
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

/** One bouncing dot of the thinking indicator. */
function Dot({ delay }: { delay: number }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-bounce"
      style={{ animationDelay: `${delay}ms` }}
    />
  );
}
