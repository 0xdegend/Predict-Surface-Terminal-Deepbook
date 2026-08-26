'use client';

/**
 * Auto mode: Kelly's setup conversation, and the little language helpers that let her
 * acknowledge what she just understood.
 *
 * Split out of autopilot-panel.tsx. See lib/autopilot/read-setup.ts for the reader that
 * feeds it (rules, plus the optional model tier).
 */
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { useAutopilotStore } from '@/lib/store/autopilot-store';
import { LuArrowRight, LuCircleCheck, LuMessageSquareText, LuRotateCcw } from 'react-icons/lu';
import { MASCOT_SRC } from '@/lib/mascot';
import { num } from '@/lib/format';
import type { PresetId } from '@/lib/autopilot/presets';
import { GAP_ORDER, type ResolvedSetup, type SetupGap, type SetupIntent, mergeIntents, missingFrom, resolveSetup, wantsStart } from '@/lib/autopilot/setup-parser';
import { readSetup } from '@/lib/autopilot/read-setup';

const OPENERS = ['Keep it safe with $25', 'Balanced, $50 for an hour', 'Go bold with $100', 'Careful, $20, half an hour'];

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

const GAP_LABEL: Record<SetupGap, string> = { style: 'Style', budget: 'Budget', duration: 'For' };

/** Composer height cap, matching the co-pilot chat: roughly three lines, then scroll. */
const MAX_INPUT_H = 76;

/**
 * Build Kelly's acknowledgement from what the last reply actually taught her. Used when
 * the model is off (or added nothing), so the rule path still speaks like a person
 * instead of going silent. Amounts are always said out loud, never just applied.
 */
function ackFor(before: SetupIntent, after: SetupIntent): string | null {
  const learned: string[] = [];
  if (!before.presetNamed && after.presetNamed) learned.push(PRESET_BY_NAME[after.preset]);
  if (before.budgetUsd == null && after.budgetUsd != null) learned.push(`$${num(after.budgetUsd, 0)} in total`);
  if (before.durationMins == null && after.durationMins != null) learned.push(durationWords(after.durationMins));
  if (before.perTradeUsd !== after.perTradeUsd && after.perTradeUsd != null) {
    learned.push(`$${num(after.perTradeUsd, 0)} a bet`);
  }
  if (before.live !== after.live && after.live != null) learned.push(after.live ? 'trading live' : 'watch mode');
  if (learned.length === 0) return null;
  return `Got it: ${listWords(learned)}.`;
}

const PRESET_BY_NAME: Record<PresetId, string> = { cautious: 'careful', balanced: 'balanced', bold: 'bold' };

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
 * every required piece has been stated by the trader, and even then the plan line and
 * the Start button are still the confirm.
 */
export function KellySetupCard({
  current,
  onApply,
  onStart,
  startIssue,
}: {
  current: { budgetUsd: number; perTradeUsd: number; armDurationMs: number };
  onApply: (r: ResolvedSetup) => void;
  /** Begin the run from the conversation. Runs the SAME path as the Start button, which
   *  ends at the arm confirm: that dialog is where watch-vs-live and the funding route
   *  are chosen, and it is the last stop before real money, so a typed word opens it
   *  rather than stepping around it. */
  onStart?: () => void;
  /** Why starting is blocked right now (the panel's own arm check), so Kelly can say it
   *  in words instead of the trader typing "start" into silence. */
  startIssue?: string | null;
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
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const gaps = missingFrom(intent);
  const openGap = gaps[0] ?? null;
  const done = gaps.length === 0 && turns.length > 0;

  // Keep the newest turn in view as the thread grows.
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns.length, busy]);

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
      push('kelly', "On it. Confirm the plan and I'll start.");
      onStart?.();
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
      else lines.push("That's everything. Check the plan, then say \u201cstart\u201d whenever you're ready.");
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

  return (
    <div className="glass-card flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <Image
          src={MASCOT_SRC.thinking}
          alt=""
          width={36}
          height={36}
          aria-hidden
          className="mt-0.5 h-9 w-9 flex-none rounded-full object-contain"
        />
        <div className="min-w-0 flex-1">
          <p className="eyebrow flex items-center gap-1.5">
            <LuMessageSquareText size={12} className="text-accent" /> Set it up for me
          </p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-text-2">
            Tell me how you want to play it, in your own words. I&rsquo;ll ask about anything you leave out.
          </p>
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

      {/* What Kelly has so far. Three slots, filling in as the conversation goes, so the
          trader can see what is still outstanding without reading back up the thread. */}
      <div className="flex flex-wrap gap-1.5">
        {GAP_ORDER.map((g) => {
          const value = slotValue(g, intent);
          return (
            <span
              key={g}
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] ring-1 ring-inset transition-colors ${
                value
                  ? 'bg-(--accent-soft) text-accent ring-(--accent-line)'
                  : openGap === g
                    ? 'bg-white/6 text-text-1 ring-white/15'
                    : 'bg-white/3 text-text-3 ring-transparent'
              }`}
            >
              {value ? <LuCircleCheck size={11} className="flex-none" /> : <span className="h-1.5 w-1.5 rounded-full bg-current opacity-40" />}
              <span className="text-[10px] uppercase tracking-wide opacity-70">{GAP_LABEL[g]}</span>
              {value ?? '?'}
            </span>
          );
        })}
      </div>

      {turns.length > 0 && (
        <div ref={threadRef} className="scroll-quiet flex max-h-56 flex-col gap-2 overflow-y-auto pr-1">
          {turns.map((t) => (
            <div
              key={t.id}
              className={`max-w-[88%] rounded-xl px-3 py-2 text-[12.5px] leading-relaxed ${
                t.who === 'kelly'
                  ? 'glass-inset self-start text-text-1'
                  : 'self-end bg-(--accent-soft) text-text-1 ring-1 ring-inset ring-(--accent-line)'
              }`}
            >
              {t.text}
            </div>
          ))}
          {busy && (
            <div className="glass-inset self-start rounded-xl px-3 py-2 text-[12.5px] text-text-3">
              <span className="inline-flex gap-1">
                <Dot delay={0} />
                <Dot delay={120} />
                <Dot delay={240} />
              </span>
            </div>
          )}
        </div>
      )}

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
          placeholder={openGap && turns.length > 0 ? answerHint(openGap) : 'Try "cautious, $25 for an hour"'}
          aria-label="Tell Kelly how you want Autopilot to run"
          // 16px is deliberate: iOS Safari force-zooms a focused field under 16px.
          className="scroll-quiet glass-inset w-full resize-none rounded-lg px-3 py-2.5 text-[16px] leading-snug text-text-1 outline-none transition-colors placeholder:text-text-3 focus:border-(--accent-line) disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          aria-label="Send"
          className="glass-inset flex-none rounded-lg p-2.5 text-text-2 transition-colors hover:text-text-1 disabled:opacity-40"
        >
          <LuArrowRight size={16} />
        </button>
      </form>

      {/* Openers before the first message, then answers to whatever Kelly just asked. */}
      <div className="flex flex-wrap gap-1.5">
        {(turns.length === 0 ? OPENERS : openGap ? GAP_CHIPS[openGap] : done ? ['Start'] : []).map((s) => (
          <button
            key={s}
            type="button"
            disabled={busy}
            onClick={() => void send(s)}
            className="glass-inset rounded-full px-3 py-2 text-[11px] text-text-2 transition-colors hover:border-(--accent-line) hover:text-text-1 disabled:opacity-40 sm:px-2.5 sm:py-1"
          >
            {s}
          </button>
        ))}
      </div>

      {done ? (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-accent">
          <LuCircleCheck size={12} className="mt-px flex-none" />
          Your settings are loaded and the plan is on the right. Say &ldquo;start&rdquo; when you want it to
          begin, and nothing runs until you confirm.
        </p>
      ) : (
        <p className="text-[11px] leading-relaxed text-text-3">
          Say a style, an amount, and how long. I&rsquo;ll ask about whatever you leave out, and I never put up an
          amount you didn&rsquo;t choose.
        </p>
      )}
    </div>
  );
}

/** Drop a sentence-cased blocker into the middle of one of Kelly's own sentences. */
function lowerFirst(t: string): string {
  return t.charAt(0).toLowerCase() + t.slice(1);
}

/** The value shown in a "so far" slot, or null while it is still unknown. */
function slotValue(gap: SetupGap, intent: SetupIntent): string | null {
  if (gap === 'style') return intent.presetNamed ? PRESET_BY_NAME[intent.preset] : null;
  if (gap === 'budget') return intent.budgetUsd != null ? `$${num(intent.budgetUsd, 0)}` : null;
  return intent.durationMins != null ? durationWords(intent.durationMins) : null;
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
