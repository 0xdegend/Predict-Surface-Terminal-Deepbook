'use client';

/**
 * Arena hero tiles — the pieces the bento header (arena-header.tsx) composes:
 *   · ArenaBanner  — the looping-video hero card with the gold wordmark.
 *   · PrizeTile    — the season prize pool.
 *   · CountdownTile— a real ticking clock to the season close.
 *
 * The banner plays `/degen-arena.mp4` behind a scrim (see globals.css .arena-*);
 * the painted `.arena-banner` stays as the loading + reduced-motion fallback.
 * Grid placement is passed in via `className` so the header owns the layout.
 */
import { LuScrollText, LuChevronDown, LuCheck, LuCoins } from 'react-icons/lu';
import { num } from '@/lib/format';
import { useMounted } from '@/lib/hooks/use-mounted';
import { useNow, countdownParts } from '../rewards/shared';
import { AboutArena } from './arena-about';
import { SEASON, PRIZE_POOL } from '@/lib/arena/data';

const ARENA_HUE = '#e6b450'; // warm arena gold (the app's --warn tone)

export function ArenaBanner({
  mode,
  joined,
  onToggleRules,
  showRules,
  className = '',
}: {
  mode: 'hub' | 'detail';
  joined?: boolean;
  onToggleRules: () => void;
  showRules: boolean;
  className?: string;
}) {
  return (
    <div
      className={`arena-banner rise relative flex min-h-[228px] flex-col justify-between overflow-hidden rounded-2xl p-4 sm:min-h-[268px] sm:p-5 ${className}`}
    >
      {/* Looping arena video behind the wordmark (painted banner is the loading +
          reduced-motion fallback). Muted/inline so it autoplays everywhere. */}
      <div className="arena-media pointer-events-none absolute inset-0" aria-hidden>
        <video
          className="arena-video h-full w-full object-cover"
          src="/degen-arena.mp4"
          autoPlay
          loop
          muted
          playsInline
          preload="auto"
        />
        <span className="arena-scrim absolute inset-0" />
      </div>

      {/* top controls */}
      <div className="relative z-10 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Solid glass pill (matches the Season control) so it stays legible
              over any video frame — the old ctrl-soft vanished over the sky. */}
          <button
            onClick={onToggleRules}
            aria-pressed={showRules}
            className={`glass-menu inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
              showRules ? 'text-up' : 'text-text-1'
            }`}
          >
            <LuScrollText size={13} className="text-accent" /> Rules
          </button>
          <AboutArena />
        </div>
        <div className="flex items-center gap-2">
          {mode === 'detail' && joined && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
              style={{ color: 'var(--up)', background: 'var(--accent-soft)' }}
            >
              <LuCheck size={12} /> Joined
            </span>
          )}
          <button className="glass-menu inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-text-1">
            {SEASON.label}
            <LuChevronDown size={13} className="text-text-3" />
          </button>
        </div>
      </div>

      {/* wordmark */}
      <div className="relative z-10 mt-4">
        <h1 className="arena-wordmark text-[32px] font-bold leading-none tracking-[0.16em] sm:text-[46px]">
          DEGEN ARENA
        </h1>
        <p className="mt-2 text-[12px] tracking-wide text-text-2">
          Welcome to {SEASON.label} — factions clash for the prize pool
        </p>
      </div>
    </div>
  );
}

export function PrizeTile({ className = '' }: { className?: string }) {
  return (
    <div
      className={`glass-card rise flex flex-col justify-center gap-1.5 rounded-2xl p-4 sm:p-5 ${className}`}
      style={{ animationDelay: '60ms' }}
    >
      <span className="eyebrow inline-flex items-center gap-1.5">
        <LuCoins size={12} style={{ color: ARENA_HUE }} /> {SEASON.label} prize pool
      </span>
      <div className="font-mono text-[30px] leading-none tabular-nums text-text-1">
        {num(PRIZE_POOL, 0)}
        <span className="ml-1.5 text-[12px] text-text-3">DUSDC</span>
      </div>
      <span className="text-[10px] text-text-3">Funded by the 1% Skew fee treasury</span>
    </div>
  );
}

export function CountdownTile({ className = '' }: { className?: string }) {
  const mounted = useMounted();
  const now = useNow(1000);
  const parts = countdownParts(SEASON.endMs - now);
  return (
    <div
      className={`glass-card rise flex flex-col justify-center gap-2 rounded-2xl p-4 sm:p-5 ${className}`}
      style={{ animationDelay: '90ms' }}
    >
      <span className="eyebrow">Season ends in</span>
      <div className="flex items-baseline gap-1.5 font-mono tabular-nums text-text-1">
        <CountUnit value={mounted ? parts.d : '--'} unit="d" />
        <CountUnit value={mounted ? parts.h : '--'} unit="h" />
        <CountUnit value={mounted ? parts.m : '--'} unit="m" />
        <CountUnit value={mounted ? parts.s : '--'} unit="s" />
      </div>
    </div>
  );
}

function CountUnit({ value, unit }: { value: string; unit: string }) {
  return (
    <span className="text-[19px] leading-none">
      {value}
      <span className="ml-0.5 text-[11px] text-text-3">{unit}</span>
    </span>
  );
}
