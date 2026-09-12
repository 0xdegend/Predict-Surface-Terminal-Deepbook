'use client';

/**
 * RunPill — a live Autopilot run in one line: trading or paused, bets placed, time left.
 *
 * Two homes, one component, so the wording can never drift between them. Inside Kelly's
 * hub it sits in the tab bar as a button that switches to the Autopilot tab. Everywhere
 * else on /v2 it floats just above the Ask Kelly launcher as a link, because the engine
 * now keeps trading while the trader reads the leaderboard, and a run spending money
 * off-screen must never be out of sight.
 *
 * Renders nothing unless a run is live, so either caller can mount it unconditionally.
 */
import Link from 'next/link';
import { LuPause } from 'react-icons/lu';
import { useAutopilotStore } from '@/lib/store/autopilot-store';
import { useNow } from '@/lib/hooks/use-now';
import { hrefForTab } from '@/lib/kelly/hub-tabs';

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

interface Props {
  /** Server clock for the first paint. Defaults to 0, which is safe wherever there is no
   *  server value: the store starts idle and hydrates after mount, so both the server and
   *  the first client render draw nothing either way. */
  serverNow?: number;
  /** Switch tabs in place. With a handler the pill is a button; without one it is a link
   *  to the Autopilot tab, which is what an off-hub caller wants. */
  onOpen?: () => void;
  /** True when the Autopilot tab is already showing: still a read, no longer a control. */
  disabled?: boolean;
  className?: string;
}

export function RunPill({ serverNow = 0, onOpen, disabled = false, className = '' }: Props) {
  const status = useAutopilotStore((s) => s.status);
  const tradeCount = useAutopilotStore((s) => s.run.tradeCount);
  const armedAt = useAutopilotStore((s) => s.run.armedAt);
  const armDurationMs = useAutopilotStore((s) => s.limits.armDurationMs);
  const running = status === 'armed' || status === 'paused';
  const now = useNow(serverNow);
  if (!running) return null;

  const left = mmss(Math.max(0, armedAt + armDurationMs - now));
  const bets = `${tradeCount} bet${tradeCount === 1 ? '' : 's'}`;
  const paused = status === 'paused';
  const title = paused ? 'Autopilot is paused until gas is topped up' : 'Autopilot is trading';
  const cls = `inline-flex max-w-full items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
    paused
      ? 'border-[rgba(230,180,80,0.35)] bg-(--warn-soft) text-text-1'
      : 'border-(--accent-line) bg-(--accent-soft) text-text-1'
  } ${disabled ? 'cursor-default' : 'hover:brightness-110'} ${className}`;

  const inner = (
    <>
      {paused ? (
        <LuPause size={11} className="flex-none text-text-2" />
      ) : (
        <span className="relative flex h-2 w-2 flex-none">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60 motion-reduce:hidden" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
        </span>
      )}
      <span className="truncate">
        {paused ? 'Autopilot paused' : 'Autopilot trading'}
        <span className="hidden sm:inline">
          {' '}· <span className="font-mono tabular-nums">{bets}</span> ·{' '}
          <span className="font-mono tabular-nums">{left}</span> left
        </span>
      </span>
    </>
  );

  if (onOpen) {
    return (
      <button type="button" onClick={onOpen} disabled={disabled} title={title} className={cls}>
        {inner}
      </button>
    );
  }
  return (
    <Link href={hrefForTab('autopilot')} title={title} className={cls} prefetch={false}>
      {inner}
    </Link>
  );
}
