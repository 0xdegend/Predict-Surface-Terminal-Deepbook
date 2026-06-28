'use client';

/**
 * DeploymentToggle — the Legacy ↔ Latest switch.
 *
 * A two-segment control with a sliding glass thumb. "Legacy" = the current,
 * frozen deployment (kept fully working). "Latest" = the new Predict redesign.
 * Until the v2 layer ships (V2_READY), "Latest" is a disabled teaser tagged
 * "Soon" so users see what's coming but can never land in a half-built path.
 *
 * Copy is deliberately plain (no protocol jargon) — see the migration quality
 * bar. Reads the persisted deployment store behind a mounted guard so SSR and
 * the first client paint agree.
 */
import { useDeploymentStore, v2Selectable } from '@/lib/store/deployment-store';
import { useMounted } from '@/lib/hooks/use-mounted';
import { useLegacyStatus } from '@/lib/hooks/use-legacy-status';
import type { Deployment } from '@/config/predict';

const OPTIONS: { id: Deployment; label: string; hint: string }[] = [
  { id: 'legacy', label: 'Legacy', hint: 'The original Skew — keep trading and claiming here until it winds down.' },
  { id: 'v2', label: 'Latest', hint: 'The new Predict release — faster markets, leverage, and more.' },
];

export function DeploymentToggle() {
  const mounted = useMounted();
  const stored = useDeploymentStore((s) => s.deployment);
  const setDeployment = useDeploymentStore((s) => s.setDeployment);
  const legacy = useLegacyStatus();

  // Before mount, render the server default so hydration matches.
  const active: Deployment = mounted ? stored : 'legacy';
  const activeIndex = active === 'v2' ? 1 : 0;

  // Graceful sunset: once Latest is selectable, a dark legacy server means the
  // old oracles have wound down — flag Legacy "offline" and steer to Latest.
  // Dormant until v2 is selectable (legacy is the only live option before then).
  const legacyOffline = v2Selectable && legacy.checked && !legacy.online;

  /** Per-option availability + the little uppercase tag (Soon / Offline). */
  function optState(id: Deployment): { disabled: boolean; tag: string | null } {
    if (id === 'v2') return { disabled: !v2Selectable, tag: v2Selectable ? null : 'Soon' };
    return { disabled: legacyOffline, tag: legacyOffline ? 'Offline' : null };
  }

  return (
    <div
      role="radiogroup"
      aria-label="Protocol version"
      // Lives in the right-hand cluster beside network/wallet. Shown xl+ only:
      // at lg the centered market chip + wallet already fill the row (the wallet
      // address even wraps), so anything extra overflows. Below xl it'll get a
      // home in the menu when v2 ships. shrink-0 so it never crushes neighbours.
      className="relative hidden h-8 shrink-0 select-none grid-cols-2 items-center rounded-lg p-0.5 backdrop-blur-md backdrop-saturate-150 xl:inline-grid"
      style={{
        // Recessed frosted track — translucent fill + soft inner shadow for
        // depth, no hard border (matches the .glass language).
        background: 'color-mix(in srgb, var(--bg-2) 55%, transparent)',
        boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.28)',
      }}
    >
      {/* Sliding thumb — a frosted glass pill that floats over the track. Half-
          width, eased translate. No white ring; depth from a faint top sheen. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-md backdrop-blur-sm transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{
          transform: `translateX(${activeIndex * 100}%)`,
          background:
            'linear-gradient(180deg, color-mix(in srgb, var(--accent) 18%, transparent), var(--accent-soft))',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
        }}
      />
      {OPTIONS.map((opt) => {
        const isActive = active === opt.id;
        const { disabled, tag } = optState(opt.id);
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            disabled={disabled}
            title={tag ? `${opt.hint} (${tag.toLowerCase()})` : opt.hint}
            onClick={() => !disabled && setDeployment(opt.id)}
            className={`relative z-10 flex h-7 items-center justify-center gap-1.5 rounded-md px-2.5 font-mono text-[11px] tracking-tight transition-colors ${
              isActive ? 'text-text-1' : 'text-text-2 hover:text-text-1'
            } ${disabled ? 'cursor-not-allowed hover:text-text-2' : ''}`}
          >
            <span className={disabled ? 'opacity-55' : undefined}>{opt.label}</span>
            {tag && (
              <span className="rounded-[3px] bg-white/5 px-1 py-0.5 text-[8px] font-medium uppercase leading-none tracking-[0.12em] text-text-3">
                {tag}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
