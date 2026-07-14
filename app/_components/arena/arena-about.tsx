'use client';

/**
 * AboutArena — the "What is Degen Arena?" entry point and its explainer.
 *
 * Self-contained: it renders its own trigger pill (dropped into the banner
 * controls, next to Rules) and owns the modal open state, so the banner and
 * header don't have to thread another prop pair through. The Rules panel covers
 * the points/pool mechanic; this answers the higher-level "what is this?" — the
 * pitch plus the invite-only + owner-override economics.
 */
import { useState } from 'react';
import { LuCircleHelp, LuLink, LuCrown, LuTrophy } from 'react-icons/lu';
import { Modal } from '@/app/_components/ui/modal';

export function AboutArena() {
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* Solid glass pill (matches Rules / Season) so it stays legible over any
          video frame. Long label on sm+, compact "About" on phones. */}
      <button
        onClick={() => setOpen(true)}
        className="glass-menu inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-text-1 transition-colors"
      >
        <LuCircleHelp size={13} className="text-accent" />
        <span className="hidden sm:inline">What is Degen Arena?</span>
        <span className="sm:hidden">About</span>
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="What is Degen Arena?"
        subtitle="An eSports-themed tournament for the factions"
        maxWidthClass="max-w-lg"
        variant="glass"
        mascot="confident"
        contentClassName="px-5 pb-5"
      >
        <div className="flex flex-col gap-4">
          <p className="text-[13px] leading-relaxed text-text-2">
            The <span className="font-semibold text-text-1">Degen Arena</span> is a massive
            eSports-themed tournament where teams compete for a share of the Skew fees.
          </p>

          <div className="flex flex-col gap-2.5">
            <AboutRow
              n={1}
              hue="#6aa6e6"
              icon={LuLink}
              title="Invite-only entry"
              body="The only way into the Arena is by joining a team through a member's referral link."
            />
            <AboutRow
              n={2}
              hue="#9d92e8"
              icon={LuCrown}
              title="Owners earn an override"
              body="Team owners earn 10% of every Point their team farms, plus another 10% from their own referrals."
            />
          </div>

          {/* Bonus callout — the fee kicker for the top of the board. */}
          <div
            className="flex items-start gap-3 rounded-xl p-3.5"
            style={{ background: 'color-mix(in srgb, var(--warn) 12%, transparent)' }}
          >
            <span
              className="mt-0.5 inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg"
              style={{ color: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 16%, transparent)' }}
            >
              <LuTrophy size={15} />
            </span>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-warn">Bonus</span>
              <span className="text-[12px] leading-relaxed text-text-2">
                The top 10 teams share a percentage of the Skew fees.
              </span>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}

function AboutRow({
  n,
  hue,
  icon: Icon,
  title,
  body,
}: {
  n: number;
  hue: string;
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        className="mt-0.5 inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg font-mono text-[12px] font-semibold"
        style={{ color: hue, background: `color-mix(in srgb, ${hue} 15%, transparent)` }}
      >
        {n}
      </span>
      <div className="flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-text-1">
          <Icon size={13} style={{ color: hue }} />
          {title}
        </span>
        <span className="text-[12px] leading-relaxed text-text-3">{body}</span>
      </div>
    </div>
  );
}
