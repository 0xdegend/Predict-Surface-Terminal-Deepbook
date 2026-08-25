'use client';

/**
 * NextPick — what Autopilot would do if you pressed Start this second.
 *
 * The setup screen described the rules and never showed their effect. You could set a
 * 75% win-chance floor and a single 1-minute window and have no idea you had just ruled
 * out every market on the board, right up until you armed a run that then sat there
 * doing nothing. This turns the rules from a description into something checkable
 * before any money is at stake.
 *
 * The read comes from `engine.preview`, which runs the armed tick's own pick-and-gate
 * (see use-autopilot-engine), so it cannot drift from real behaviour. It is one
 * would-be trade rather than a count of qualifying markets, because one pick per tick
 * is what the engine actually does.
 *
 * Deliberately quiet about outcomes: it says what she would pick and whether your rules
 * allow it. It never suggests the bet is good.
 */
import { LuTarget, LuTrendingUp, LuTrendingDown, LuHourglass } from 'react-icons/lu';
import { num } from '@/lib/format';
import { gateReasonLabel } from '@/lib/autopilot/policy';
import type { AutopilotPreview } from '@/lib/hooks/use-autopilot-engine';

export function NextPick({ preview, now }: { preview: AutopilotPreview | null; now: number }) {
  return (
    <div className="glass-card p-4">
      <p className="eyebrow mb-2.5 flex items-center gap-1.5">
        <LuTarget size={12} className="text-accent" /> If you started now
      </p>
      <Body preview={preview} now={now} />
    </div>
  );
}

function Body({ preview, now }: { preview: AutopilotPreview | null; now: number }) {
  // No preview at all: the live context has not warmed up yet. Say that plainly rather
  // than implying the rules are the problem.
  if (!preview) {
    return (
      <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-text-3">
        <LuHourglass size={13} className="mt-px flex-none" />
        Reading the market. This fills in once the live prices arrive.
      </p>
    );
  }

  // A pick exists but the trader's own rules block it, or no market sits in an allowed
  // window at all. Either way the fix is a setting, so name the setting.
  if (!preview.gate.allow) {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-[13px] leading-relaxed text-text-1">Nothing clears your rules at the moment.</p>
        <p className="text-[11.5px] leading-relaxed text-text-3">
          {gateReasonLabel(preview.gate.code).replace(/^Held back: /, '').replace(/^Waiting: /, '')}
          {preview.bet != null && preview.gate.code === 'below_min_prob'
            ? `. The best pick right now is ${Math.round(preview.bet.prob * 100)}%.`
            : '.'}
        </p>
        <p className="text-[11px] leading-relaxed text-text-3">
          That is fine to start with. She waits, and takes the first bet that fits.
        </p>
      </div>
    );
  }

  const bet = preview.bet;
  if (!bet) return null;
  const mins = Math.max(0, Math.round((bet.expiry - now) / 60_000));
  const Dir = bet.isUp ? LuTrendingUp : LuTrendingDown;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <Dir size={15} className={`flex-none translate-y-0.5 ${bet.isUp ? 'text-up' : 'text-down'}`} />
        <span className="font-mono text-[15px] tabular-nums text-text-1">
          <b className={bet.isUp ? 'text-up' : 'text-down'}>{bet.isUp ? 'UP' : 'DOWN'}</b>
          {bet.strikePrice != null && <> {bet.isUp ? 'above' : 'below'} ${num(bet.strikePrice, 0)}</>}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11.5px] tabular-nums text-text-3">
        <span>
          <span className="text-text-2">{Math.round(bet.prob * 100)}%</span> to win
        </span>
        <span aria-hidden>·</span>
        <span>settles in {mins < 1 ? 'under a minute' : `${mins} min`}</span>
        {bet.leverage > 1 && (
          <>
            <span aria-hidden>·</span>
            <span>{bet.leverage}x</span>
          </>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-text-3">
        Her current pick, and it passes your rules. The market moves, so the real first bet may differ.
      </p>
    </div>
  );
}
