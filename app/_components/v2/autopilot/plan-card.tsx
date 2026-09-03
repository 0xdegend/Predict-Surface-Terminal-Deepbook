'use client';

/**
 * PlanCard — the plan as four illustrated phases instead of one sentence.
 *
 * WHY IT CHANGED. The plan was a paragraph: "Up to 3 careful UP or DOWN bets, about $33
 * each, over the next 15 minutes. Stops after 2 losses in a row." Everything true, and
 * still the wrong shape for the job it does. It is the last thing read before handing
 * money to a bot, and a paragraph makes you reconstruct a sequence out of a spec. The
 * numbers were also the only thing on screen with any weight, so the actual question,
 * "what is this thing going to DO", had to be inferred.
 *
 * As phases it reads as a loop, because it is one: watch, pick, stake, stop. The copy
 * lives in lib/autopilot/plan-phases (pure and tested), and every line there maps to a
 * real check in lib/autopilot/policy, so this can never illustrate behaviour the engine
 * does not have.
 *
 * THE MOTION. The house already has a hand-authored animated icon set (nav-icons.tsx)
 * and the same rules apply here: geometry is Lucide-weight, the vocabulary is small
 * (pulse / draw / lift / turn, one per phase, so four glyphs read as one set), and all
 * timing lives in ONE place in globals.css rather than per icon.
 *
 * What differs is the trigger. Nav icons animate on hover; these run on a shared loop
 * with a per-phase delay, so the highlight walks down the list and the card performs the
 * sequence it is describing. That is a deliberate exception to the app's "no idle motion
 * in the chrome" rule, made because this IS the content rather than chrome around it,
 * and it is kept to one slow 8s cycle so it never competes with a live number. It stops
 * completely under `prefers-reduced-motion`, where every glyph renders in its finished
 * state (see the reduced-motion block in globals.css).
 *
 * Every drawn path carries `pathLength={1}`, the same normalisation nav-icons uses: a
 * dash of 1 always covers the whole stroke, so no hardcoded length can ever be wrong.
 */
import Image from 'next/image';
import { MASCOT_SRC } from '@/lib/mascot';
import { PRESETS, type PresetId, planSentence } from '@/lib/autopilot/presets';
import { planPhases, type PlanPhaseId } from '@/lib/autopilot/plan-phases';
import type { Limits, Rules } from './shared';

/** One cycle of the walk-down, split evenly between the four phases. */
const PHASE_STAGGER_MS = 2000;

export function PlanCard({
  rules,
  limits,
  live,
  presetId,
  avatar = true,
  variant = 'full',
  surface,
  learnMoreHref,
  spacious = false,
}: {
  rules: Rules;
  limits: Limits;
  /** null = the mode has not been chosen yet, so the plan stays quiet about it. */
  live: boolean | null;
  presetId: PresetId | null;
  /** Drop the inline fox where the surrounding shell already has one (the arm confirm
   *  peeks Kelly into its corner, so a second one inside would double her). */
  avatar?: boolean;
  /**
   * How much room the plan gets.
   *
   * `full` is the stepper: four rows, each with its sentence. It belongs on the setup
   * screen, where the trader is deciding what to build and the sequence is the thing
   * being taught.
   *
   * `compact` is the same four phases as a strip, over the one-line summary. It belongs
   * in the arm confirm, which is a decision surface rather than a teaching one: the
   * stepper measured 250px there and pushed the confirm button off the bottom of a
   * 375x667 phone, which is the worst possible thing to lose on a money dialog. The
   * strip keeps the phase language and every number, in about a third of the height.
   */
  variant?: 'full' | 'compact';
  /**
   * The material, which is a separate question from the density above it. `card` is a
   * peer block on a page; `inset` is nested inside another surface. Compact is used in
   * both places now (the arm confirm nests it, the running dashboard does not), so the
   * default follows each variant's usual home and the odd one out says so.
   */
  surface?: 'card' | 'inset';
  /** Where "Learn more" points. Given, the footer becomes a row: the mode line on the
   *  left and the link on the right, the way the landing's plan card reads. */
  learnMoreHref?: string;
  /** Room to breathe: the landing gives the plan a whole column, so the stepper gets
   *  bigger dots and a taller rhythm than the same list inside a dialog. */
  spacious?: boolean;
}) {
  const preset = presetId ? PRESETS.find((p) => p.id === presetId) : null;
  const phases = planPhases(rules, limits);
  const compact = variant === 'compact';
  /* On the setup screen this is a peer of "Set it up for me" and of the Manual controls,
     every one of which is a `glass-card p-4`, so it is one too: side by side, a raised
     card next to a recessed panel reads as two unrelated things rather than a pair, and
     the padding difference put their two mascots on different baselines. Inside the arm
     confirm it is nested in a dialog, where an inset with the accent edge is right. */
  const inset = (surface ?? (compact ? 'inset' : 'card')) === 'inset';

  return (
    <div
      className={
        inset
          ? 'glass-inset border-l-2 border-(--accent-line) p-3.5'
          : spacious
            ? 'glass-card flex flex-1 flex-col p-4'
            : 'glass-card p-4'
      }
    >
      <div className="flex items-start gap-3">
        {avatar && (
          <Image
            src={MASCOT_SRC.thinking}
            alt=""
            width={32}
            height={32}
            aria-hidden
            className="mt-0.5 h-8 w-8 flex-none rounded-full object-contain"
          />
        )}
        <p className="eyebrow flex items-center gap-2">
          The plan
          {/* The style as an accent chip, the same one the landing's Kelly card fills in
              for STYLE, so the two read as the same fact in two places. */}
          <span className="rounded-full bg-(--accent-soft) px-2 py-0.5 text-[9.5px] font-medium tracking-wider text-accent ring-1 ring-inset ring-(--accent-line)">
            {(preset ? preset.name : 'Custom').toUpperCase()}
          </span>
        </p>
      </div>

      {compact ? (
        <div className={avatar ? 'pl-11' : ''}>
          {/* The four phases as a strip. Wraps rather than scrolls, so a narrow phone
              gets two rows of two instead of hiding the last one off the edge.
              `plan-strip` is the hook the arming sequence uses to light them in order
              (see the arm-in block in globals.css); the per-phase delays for THAT one
              live on the list items, because the dots already carry their own inline
              delay for the slow idle walk. */}
          <ol className="plan-strip mt-2.5 flex flex-wrap items-center gap-x-1 gap-y-1.5">
            {phases.map((p, i) => (
              <li key={p.id} className="flex items-center gap-1.5">
                <span
                  className="plan-step-dot flex h-6 w-6 flex-none items-center justify-center rounded-full ring-1 ring-inset ring-white/10"
                  style={{ animationDelay: `${i * PHASE_STAGGER_MS}ms` }}
                >
                  <PhaseGlyph id={p.id} delayMs={i * PHASE_STAGGER_MS} />
                </span>
                <span className="text-[11px] leading-none text-text-2">{p.title}</span>
                {/* The connector trails the item rather than leading the next one. On a
                    narrow phone the strip wraps, and a leading dash would start the
                    second line with a stray mark; a trailing one just reads as
                    "continues over the page". */}
                {i < phases.length - 1 && <span aria-hidden className="ml-1 h-px w-2.5 bg-white/15" />}
              </li>
            ))}
          </ol>
          {/* The numbers the strip's titles leave out. This is a money dialog, so the
              full amounts stay on screen no matter how tight the room gets. */}
          <p className="mt-2.5 text-[12.5px] leading-relaxed text-text-1">{planSentence(rules, limits)}</p>
        </div>
      ) : (
      /* An ordered list because the order is the point. The spine is drawn per row so
         it stops at the last dot instead of running past it.

         TWO COLUMNS, and they are the header's two columns. The dots are the same 32px
         box as the fox above them and start at the same card padding, so one line runs
         down the left edge; the titles start at 32 + gap-3, which is exactly where "THE
         PLAN" starts. This used to indent the whole list by `pl-11` to clear the fox,
         which put the dots in a third column of their own and pushed every sentence 84px
         off the card edge. `pt-2` centres the first line of a title on its dot.

         Spacious: the list takes the card's spare height and each phase grows evenly,
         so the four steps spread down the column instead of bunching at the top with
         a void under them. The connector is drawn per row to its bottom edge, so it
         keeps up with however tall the row becomes. */
      <ol className={`flex flex-col ${spacious ? 'mt-4 flex-1' : 'mt-3'}`}>
        {phases.map((p, i) => (
          <li key={p.id} className={`relative flex gap-3 last:pb-0 ${spacious ? 'flex-1 gap-3.5 pb-4' : 'pb-3'}`}>
            {i < phases.length - 1 && (
              <span
                aria-hidden
                className={`absolute bottom-0 w-px bg-white/10 ${spacious ? 'left-5 top-11' : 'left-4 top-9'}`}
              />
            )}
            <span
              className={`plan-step-dot relative z-10 flex flex-none items-center justify-center rounded-full ring-1 ring-inset ring-white/10 ${
                spacious ? 'h-10 w-10' : 'h-8 w-8'
              }`}
              style={{ animationDelay: `${i * PHASE_STAGGER_MS}ms` }}
            >
              <PhaseGlyph id={p.id} delayMs={i * PHASE_STAGGER_MS} size={16} />
            </span>
            <div className={`min-w-0 flex-1 ${spacious ? 'pt-2' : 'pt-2'}`}>
              <p className={`font-medium leading-tight text-text-1 ${spacious ? 'text-[13.5px]' : 'text-[12.5px]'}`}>{p.title}</p>
              <p className={`mt-0.5 leading-relaxed ${spacious ? 'text-[12px] text-text-2' : 'text-[11.5px] text-text-3'}`}>{p.detail}</p>
            </div>
          </li>
        ))}
      </ol>
      )}

      {(live != null || learnMoreHref) && (
        <div
          className={`flex items-center justify-between gap-3 ${avatar ? 'pl-11' : ''} ${
            spacious ? 'mt-auto border-t border-white/6 pt-3.5' : 'mt-3'
          }`}
        >
          <p className={`leading-relaxed text-text-3 ${spacious ? 'text-[11.5px]' : 'text-[11px]'}`}>
            {live == null ? '' : live ? 'Real DUSDC from your trading account.' : 'Watch mode: a live rehearsal, nothing is spent.'}
          </p>
          {learnMoreHref && (
            <a
              href={learnMoreHref}
              className="inline-flex flex-none items-center gap-1 text-[12px] text-accent transition-colors hover:text-text-1"
            >
              Learn more <span aria-hidden>→</span>
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------- the glyphs ------------------------------- */

/** Shared frame: Lucide's viewBox and stroke weight, so these sit with the icon set.
 *  Sized by the caller so the glyph keeps the same half-of-the-dot proportion in both
 *  variants (16 in the stepper's 32px dot, 14 in the strip's 24px one). */
function Svg({ size, children }: { size: number; children: React.ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="plan-ico"
    >
      {children}
    </svg>
  );
}

function PhaseGlyph({ id, delayMs, size = 14 }: { id: PlanPhaseId; delayMs: number; size?: number }) {
  const d = (extra = 0) => ({ animationDelay: `${delayMs + extra}ms` });
  switch (id) {
    // WATCH — pulse. Rings push out of a still centre: listening, not searching.
    case 'watch':
      return (
        <Svg size={size}>
          {/* The resting glyph: a dot broadcasting. Drawn as ordinary static strokes so
              the icon still reads as something when the pulse is not running, which is
              most of the cycle and all of the time under reduced motion. */}
          <circle cx="12" cy="12" r="2.25" />
          <circle cx="12" cy="12" r="5.5" opacity="0.45" />
          <circle cx="12" cy="12" r="8.5" opacity="0.22" />
          {/* The pulse rides on top and fades to nothing, so it adds motion without
              taking the icon away with it when it leaves. */}
          <circle className="plan-ring" cx="12" cy="12" r="5.5" style={d(0)} />
          <circle className="plan-ring" cx="12" cy="12" r="5.5" style={d(260)} />
        </Svg>
      );
    // PICK — draw. The crosshair sits still and the check writes itself across it.
    case 'pick':
      return (
        <Svg size={size}>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 1.5v2.5M12 20v2.5M1.5 12h2.5M20 12h2.5" />
          <path className="plan-draw" pathLength={1} d="M8.4 12.3l2.5 2.4 4.7-5.1" style={d(0)} />
        </Svg>
      );
    // STAKE — lift. Three stakes rise on a stagger off a fixed baseline.
    case 'stake':
      return (
        <Svg size={size}>
          <path d="M3 20.5h18" />
          <rect className="plan-bar" x="4.5" y="13" width="4.2" height="5.5" rx="1.2" style={d(0)} />
          <rect className="plan-bar" x="10" y="9.5" width="4.2" height="9" rx="1.2" style={d(140)} />
          <rect className="plan-bar" x="15.5" y="6" width="4.2" height="12.5" rx="1.2" style={d(280)} />
        </Svg>
      );
    // STOP — turn. One hand sweeps the dial once and then holds, like a timer running out.
    case 'stop':
      return (
        <Svg size={size}>
          <circle cx="12" cy="12" r="8.5" />
          <path className="plan-hand" d="M12 12V6.5" style={d(0)} />
          <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
        </Svg>
      );
  }
}
