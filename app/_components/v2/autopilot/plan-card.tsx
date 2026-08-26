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
}) {
  const preset = presetId ? PRESETS.find((p) => p.id === presetId) : null;
  const phases = planPhases(rules, limits);
  const compact = variant === 'compact';

  return (
    <div className="glass-inset border-l-2 border-(--accent-line) p-3.5">
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
        <p className="eyebrow flex items-center gap-1.5">
          The plan
          <span className="rounded-full bg-white/6 px-1.5 py-px text-[9.5px] font-medium text-text-2">
            {preset ? preset.name : 'Custom'}
          </span>
        </p>
      </div>

      {compact ? (
        <div className={avatar ? 'pl-11' : ''}>
          {/* The four phases as a strip. Wraps rather than scrolls, so a narrow phone
              gets two rows of two instead of hiding the last one off the edge. */}
          <ol className="mt-2.5 flex flex-wrap items-center gap-x-1 gap-y-1.5">
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
         it stops at the last dot instead of running past it. */
      <ol className={`mt-3 flex flex-col ${avatar ? 'pl-11' : ''}`}>
        {phases.map((p, i) => (
          <li key={p.id} className="relative flex gap-3 pb-3 last:pb-0">
            {i < phases.length - 1 && (
              <span aria-hidden className="absolute left-[14px] top-8 bottom-0 w-px bg-white/10" />
            )}
            <span
              className="plan-step-dot relative z-10 flex h-7 w-7 flex-none items-center justify-center rounded-full ring-1 ring-inset ring-white/10"
              style={{ animationDelay: `${i * PHASE_STAGGER_MS}ms` }}
            >
              <PhaseGlyph id={p.id} delayMs={i * PHASE_STAGGER_MS} />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="text-[12.5px] font-medium leading-tight text-text-1">{p.title}</p>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-text-3">{p.detail}</p>
            </div>
          </li>
        ))}
      </ol>
      )}

      {live != null && (
        <p className={`mt-3 text-[11px] leading-relaxed text-text-3 ${avatar ? 'pl-11' : ''}`}>
          {live ? 'Real DUSDC from your trading account.' : 'Watch mode: a live rehearsal, nothing is spent.'}
        </p>
      )}
    </div>
  );
}

/* ------------------------------- the glyphs ------------------------------- */

/** Shared frame: Lucide's viewBox and stroke weight, so these sit with the icon set. */
function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={14}
      height={14}
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

function PhaseGlyph({ id, delayMs }: { id: PlanPhaseId; delayMs: number }) {
  const d = (extra = 0) => ({ animationDelay: `${delayMs + extra}ms` });
  switch (id) {
    // WATCH — pulse. Rings push out of a still centre: listening, not searching.
    case 'watch':
      return (
        <Svg>
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
        <Svg>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 1.5v2.5M12 20v2.5M1.5 12h2.5M20 12h2.5" />
          <path className="plan-draw" pathLength={1} d="M8.4 12.3l2.5 2.4 4.7-5.1" style={d(0)} />
        </Svg>
      );
    // STAKE — lift. Three stakes rise on a stagger off a fixed baseline.
    case 'stake':
      return (
        <Svg>
          <path d="M3 20.5h18" />
          <rect className="plan-bar" x="4.5" y="13" width="4.2" height="5.5" rx="1.2" style={d(0)} />
          <rect className="plan-bar" x="10" y="9.5" width="4.2" height="9" rx="1.2" style={d(140)} />
          <rect className="plan-bar" x="15.5" y="6" width="4.2" height="12.5" rx="1.2" style={d(280)} />
        </Svg>
      );
    // STOP — turn. One hand sweeps the dial once and then holds, like a timer running out.
    case 'stop':
      return (
        <Svg>
          <circle cx="12" cy="12" r="8.5" />
          <path className="plan-hand" d="M12 12V6.5" style={d(0)} />
          <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
        </Svg>
      );
  }
}
