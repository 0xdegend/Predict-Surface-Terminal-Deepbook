'use client';

/**
 * ArenaHero — the "DEGEN ARENA" banner + the season economics panel.
 *
 * The banner is drawn entirely in CSS (a warm glow + a faint colonnade) rather
 * than a stock photo, so it stays on-brand with the terminal's dark
 * "engineered minimalism" and ships zero assets. The economics panel carries
 * the season prize pool and a *real* ticking countdown to the season close, so
 * the surface feels live rather than a static mock.
 */
import { LuScrollText, LuChevronLeft, LuChevronDown, LuCheck, LuCoins } from 'react-icons/lu';
import { num } from '@/lib/format';
import { useMounted } from '@/lib/hooks/use-mounted';
import { useNow, countdownParts } from '../rewards/shared';
import { SEASON, PRIZE_POOL } from '@/lib/arena/data';

const ARENA_HUE = '#e6b450'; // warm arena gold (the app's --warn tone)

export function ArenaHero({
  mode,
  joined,
  onBack,
  onToggleRules,
  showRules,
}: {
  mode: 'hub' | 'detail';
  joined?: boolean;
  onBack?: () => void;
  onToggleRules: () => void;
  showRules: boolean;
}) {
  const mounted = useMounted();
  const now = useNow(1000);
  const parts = countdownParts(SEASON.endMs - now);

  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_minmax(0,300px)]">
      {/* ---- Banner ---- */}
      <div className="arena-banner rise relative flex min-h-[168px] flex-col justify-between overflow-hidden rounded-2xl p-4 sm:p-5">
        {/* top controls */}
        <div className="relative flex items-center justify-between">
          <div className="flex items-center gap-2">
            {mode === 'detail' && (
              <button
                onClick={onBack}
                className="ctrl-soft inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-text-2"
              >
                <LuChevronLeft size={14} /> Back
              </button>
            )}
            <button
              onClick={onToggleRules}
              aria-pressed={showRules}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                showRules ? 'bg-[var(--accent-soft)] text-text-1' : 'ctrl-soft text-text-2'
              }`}
            >
              <LuScrollText size={13} /> Rules
            </button>
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
        <div className="relative mt-4">
          <h1 className="arena-wordmark text-[30px] font-bold leading-none tracking-[0.16em] sm:text-[40px]">
            DEGEN ARENA
          </h1>
          <p className="mt-2 text-[12px] tracking-wide text-text-3">
            Welcome to {SEASON.label} — factions clash for the prize pool
          </p>
        </div>
      </div>

      {/* ---- Economics panel ---- */}
      <div className="glass-card rise flex flex-col justify-between gap-3 rounded-2xl p-4" style={{ animationDelay: '60ms' }}>
        <div className="flex flex-col gap-1.5">
          <span className="eyebrow inline-flex items-center gap-1.5">
            <LuCoins size={12} style={{ color: ARENA_HUE }} /> {SEASON.label} prize pool
          </span>
          <div className="font-mono text-[26px] leading-none tabular-nums text-text-1">
            {num(PRIZE_POOL, 0)}
            <span className="ml-1.5 text-[12px] text-text-3">DUSDC</span>
          </div>
          <span className="text-[10px] text-text-3">Funded by the 1% Skew fee treasury</span>
        </div>

        <div className="hairline-fade" />

        <div className="flex flex-col gap-1.5">
          <span className="eyebrow">Season ends in</span>
          <div className="flex items-baseline gap-1.5 font-mono tabular-nums text-text-1">
            <CountUnit value={mounted ? parts.d : '--'} unit="d" />
            <CountUnit value={mounted ? parts.h : '--'} unit="h" />
            <CountUnit value={mounted ? parts.m : '--'} unit="m" />
            <CountUnit value={mounted ? parts.s : '--'} unit="s" />
          </div>
        </div>
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
