'use client';

/**
 * DeploymentToggle — the Legacy ↔ Latest switch.
 *
 * A two-segment control with a sliding glass thumb. "Latest" (tagged Beta) is
 * the live Predict redesign and the default — root (/) lands there. "Legacy" is
 * the original, now-frozen deployment: its market data is offline, but it stays
 * reachable at /legacy so traders can still open Portfolio to claim old
 * positions. (Before V2_READY, "Latest" was a disabled "Soon" teaser.)
 *
 * Copy is deliberately plain (no protocol jargon) — see the migration quality
 * bar. Reads the persisted deployment store behind a mounted guard so SSR and
 * the first client paint agree.
 */
import { usePathname, useRouter } from 'next/navigation';
import { useDeploymentStore, v2Selectable } from '@/lib/store/deployment-store';
import { useLegacyStatus } from '@/lib/hooks/use-legacy-status';
import type { Deployment } from '@/config/predict';

const OPTIONS: { id: Deployment; label: string; hint: string }[] = [
  { id: 'legacy', label: 'Legacy', hint: 'The original Skew — trading has wound down; open it to claim any old positions.' },
  { id: 'v2', label: 'Latest', hint: 'The new Predict release — faster markets, leverage, and more. Now live.' },
];

export function DeploymentToggle() {
  const pathname = usePathname();
  const router = useRouter();
  const setDeployment = useDeploymentStore((s) => s.setDeployment);
  const legacy = useLegacyStatus();

  // Which experience are we in? Routes are separate (/v2/* = Latest, else Legacy),
  // and pathname is SSR-consistent so this needs no mounted guard.
  const onV2Route = pathname?.startsWith('/v2') ?? false;
  const active: Deployment = onV2Route ? 'v2' : 'legacy';
  const activeIndex = active === 'v2' ? 1 : 0;

  // Graceful sunset: once Latest is selectable, a dark legacy server means the
  // old oracles have wound down — mark Legacy "offline" as honest info. It stays
  // CLICKABLE, though: traders still need to reach /legacy → Portfolio to claim
  // old positions, so "offline" is a label, never a lock.
  const legacyOffline = v2Selectable && legacy.checked && !legacy.online;

  /** Selecting a side: remember the preference and navigate to that experience.
   *  Legacy lives at /legacy now (root redirects to /v2), so the two sides never
   *  bounce through the redirect. */
  function choose(id: Deployment) {
    if (id === active) return;
    setDeployment(id);
    router.push(id === 'v2' ? '/v2' : '/legacy');
  }

  /** Per-option availability + the little uppercase tag (Beta / Soon / Offline). */
  function optState(id: Deployment): { disabled: boolean; tag: string | null } {
    if (id === 'v2') {
      // Live now → selectable, tagged "Beta". (Pre-launch it was a disabled "Soon"
      // teaser, still reachable when already on a /v2 route.)
      return { disabled: !v2Selectable && !onV2Route, tag: v2Selectable ? 'Beta' : 'Soon' };
    }
    // Legacy is never disabled — claiming still lives there; "Offline" is just a
    // label once its market data goes dark.
    return { disabled: false, tag: legacyOffline ? 'Offline' : null };
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
            onClick={() => !disabled && choose(opt.id)}
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
