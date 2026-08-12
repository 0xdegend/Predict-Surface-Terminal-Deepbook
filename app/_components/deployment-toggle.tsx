"use client";

/**
 * DeploymentToggle — the Legacy ↔ Latest switch.
 *
 * A compact segmented control: two labelled sides ("Legacy", "Latest") flanking
 * a central glass swap-circle (the one sanctioned off-canvas accent glow). The
 * active side lights up with the accent glass fill; the other stays quiet. Each
 * side carries a small lowercase status line — "offline" for the wound-down
 * Legacy backend, "live" for the current Latest release.
 *
 * Two variants, one source of truth for all the availability logic:
 *   • "bar"   (default) — the desktop chrome control. Inline, compact, shown xl+
 *              only (at lg the centered chip + wallet already fill the header row).
 *   • "sheet" — the mobile home. Full-width, touch-sized; lives in the BottomNav
 *              "More" sheet so the switch is reachable on phones too (the desktop
 *              header nav is hidden there).
 *
 * "Latest" (v2) is the live Predict redesign and the default — root (/) lands
 * there. "Legacy" is the original, now-frozen deployment: its market data is
 * offline, but it stays reachable at /legacy so traders can still open Portfolio
 * to claim old positions. (Before V2_READY, "Latest" was a disabled "Soon"
 * teaser.)
 *
 * Copy is deliberately plain (no protocol jargon) — see the migration quality
 * bar. Routes are separate (/v2/* = Latest, else Legacy) and pathname is
 * SSR-consistent, so no mounted guard is needed.
 */
import { usePathname, useRouter } from "next/navigation";
import { LuArchive, LuActivity, LuArrowLeftRight } from "react-icons/lu";
import { useDeploymentStore, v2Selectable } from "@/lib/store/deployment-store";
import { useLegacyStatus } from "@/lib/hooks/use-legacy-status";
import type { Deployment } from "@/config/predict";
import type { IconType } from "react-icons";

type Variant = "bar" | "sheet";

const OPTIONS: {
  id: Deployment;
  label: string;
  Icon: IconType;
  hint: string;
}[] = [
  {
    id: "legacy",
    label: "Legacy",
    Icon: LuArchive,
    hint: "The original Skew — trading has wound down; open it to claim any old positions.",
  },
  {
    id: "v2",
    label: "Latest",
    Icon: LuActivity,
    hint: "The new Predict release — faster markets, leverage, and more. Now live.",
  },
];

// Per-variant sizing. The markup (two segments + centre swap-circle) is shared;
// only the dimensions and the responsive visibility differ.
const SIZES = {
  bar: {
    track: "hidden h-9 shrink-0 rounded-full xl:inline-flex",
    icon: 14,
    label: "text-[11px]",
    status: "text-[8px]",
    padL: "pl-3 pr-6",
    padR: "pl-6 pr-3",
    circle: "h-7 w-7",
    circleIcon: 12,
  },
  sheet: {
    track: "flex h-12 w-full rounded-2xl",
    icon: 16,
    label: "text-[13px]",
    status: "text-[9px]",
    padL: "pl-4 pr-9",
    padR: "pl-9 pr-4",
    circle: "h-9 w-9",
    circleIcon: 14,
  },
} satisfies Record<Variant, Record<string, unknown>>;

function StatusLine({
  tag,
  textClass,
}: {
  tag: string | null;
  textClass: string;
}) {
  if (!tag) return <span aria-hidden className="block h-[9px]" />;
  const live = tag === "Live";
  return (
    <span
      className={`inline-flex items-center leading-none tracking-[0.14em] ${textClass} font-medium lowercase ${
        live ? "text-accent" : "text-text-3"
      }`}
    >
      {tag}
    </span>
  );
}

export function DeploymentToggle({
  variant = "bar",
  onSelect,
}: {
  variant?: Variant;
  /** Fired after a real (cross-deployment) switch — lets the mobile sheet close. */
  onSelect?: () => void;
} = {}) {
  const pathname = usePathname();
  const router = useRouter();
  const setDeployment = useDeploymentStore((s) => s.setDeployment);
  const legacy = useLegacyStatus();
  const sz = SIZES[variant];

  // Which experience are we in? Routes are separate (/v2/* = Latest, else Legacy).
  const onV2Route = pathname?.startsWith("/v2") ?? false;
  const active: Deployment = onV2Route ? "v2" : "legacy";

  // Graceful sunset: once Latest is selectable, a dark legacy server means the
  // old oracles have wound down — mark Legacy "offline" as honest info. It stays
  // CLICKABLE, though: traders still need /legacy → Portfolio to claim old
  // positions, so "offline" is a label, never a lock.
  const legacyOffline = v2Selectable && legacy.checked && !legacy.online;

  /** Selecting a side: remember the preference and navigate to that experience. */
  function choose(id: Deployment) {
    if (id === active) return;
    setDeployment(id);
    router.push(id === "v2" ? "/v2" : "/legacy");
    onSelect?.();
  }

  /** Per-option availability + the little status word (Beta / Soon / Offline). */
  function optState(id: Deployment): { disabled: boolean; tag: string | null } {
    if (id === "v2") {
      // Live now → selectable, tagged "Live". (Pre-launch it was a disabled "Soon"
      // teaser, still reachable when already on a /v2 route.)
      return {
        disabled: !v2Selectable && !onV2Route,
        tag: v2Selectable ? "Live" : "Soon",
      };
    }
    // Legacy is never disabled — claiming still lives there; "Offline" is just a
    // label once its market data goes dark.
    return { disabled: false, tag: legacyOffline ? "Offline" : null };
  }

  // The centre swap-circle flips to the opposite side (when that side is live).
  const other: Deployment = active === "v2" ? "legacy" : "v2";
  const swapBlocked = optState(other).disabled;
  const otherLabel = OPTIONS.find((o) => o.id === other)!.label;

  return (
    <div
      role="radiogroup"
      aria-label="Protocol version"
      // shrink-0 so it never crushes header neighbours (bar variant).
      className={`relative select-none items-stretch backdrop-blur-md backdrop-saturate-150 ${sz.track}`}
      style={{
        // Recessed frosted track — translucent fill + soft inner shadow for depth,
        // no hard border (matches the .glass language).
        background: "color-mix(in srgb, var(--bg-2) 55%, transparent)",
        boxShadow: "inset 0 1px 2px rgba(0,0,0,0.28)",
      }}
    >
      {OPTIONS.map((opt, i) => {
        const isActive = active === opt.id;
        const { disabled, tag } = optState(opt.id);
        const isLeft = i === 0;
        const { Icon } = opt;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            disabled={disabled}
            title={tag ? `${opt.hint} (${tag.toLowerCase()})` : opt.hint}
            onClick={() => !disabled && choose(opt.id)}
            className={`group relative z-0 flex flex-1 items-center gap-2 transition-colors ${
              isLeft
                ? `justify-start rounded-l-full rounded-r-lg ${sz.padL}`
                : `justify-end rounded-r-full rounded-l-lg ${sz.padR}`
            } ${disabled ? "cursor-not-allowed" : ""}`}
            style={
              isActive
                ? {
                    // Accent glass fill for the live side + a faint accent glow.
                    background:
                      "linear-gradient(180deg, color-mix(in srgb, var(--accent) 16%, transparent), var(--accent-soft))",
                    boxShadow:
                      "inset 0 1px 0 rgba(255,255,255,0.06), 0 0 16px -6px var(--accent-glow)",
                  }
                : undefined
            }
          >
            <Icon
              size={sz.icon}
              className={`shrink-0 transition-colors ${
                isActive
                  ? "text-accent"
                  : `text-text-3 ${disabled ? "" : "group-hover:text-text-2"}`
              }`}
            />
            <span className="flex flex-col gap-px leading-none">
              <span
                className={`font-mono ${sz.label} tracking-tight transition-colors ${
                  isActive
                    ? "text-text-1"
                    : `text-text-2 ${disabled ? "opacity-55" : "group-hover:text-text-1"}`
                }`}
              >
                {opt.label}
              </span>
              <StatusLine tag={tag} textClass={sz.status} />
            </span>
          </button>
        );
      })}

      {/* Centre swap-circle — floats over the seam, flips to the opposite side.
          Frosted accent glass + the one sanctioned off-canvas glow. */}
      <button
        type="button"
        aria-label={`Switch to ${otherLabel}`}
        disabled={swapBlocked}
        title={swapBlocked ? undefined : `Switch to ${otherLabel}`}
        onClick={() => !swapBlocked && choose(other)}
        className={`absolute left-1/2 top-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full backdrop-blur-sm transition-transform ${sz.circle} ${
          swapBlocked
            ? "cursor-not-allowed opacity-40"
            : "hover:scale-105 active:scale-95"
        }`}
        style={{
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--accent) 22%, transparent), color-mix(in srgb, var(--accent) 6%, transparent))",
          border: "1px solid var(--accent-line)",
          boxShadow:
            "0 0 14px -4px var(--accent-glow), inset 0 1px 0 rgba(255,255,255,0.12)",
        }}
      >
        <LuArrowLeftRight size={sz.circleIcon} className="text-accent" />
      </button>
    </div>
  );
}
