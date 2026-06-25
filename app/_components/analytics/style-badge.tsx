'use client';

/**
 * StyleBadge — the visual for a trader archetype: a tinted icon chip + label,
 * with optional trait tags. Shared by the trader profile and the analytics
 * styles tool so a trader's badge looks identical everywhere. Hues reuse the
 * muted metric palette (no new accent), per §10.3.
 */
import { LuRocket, LuShieldCheck, LuBrackets, LuGem, LuZap, LuScale } from 'react-icons/lu';
import type { IconType } from 'react-icons';
import type { StyleArchetype, TraderStyle } from '@/lib/analytics/trader-style';
import { HUE } from '../ui/metric';

/** Per-archetype icon + muted hue. */
export const ARCH_VIS: Record<StyleArchetype['id'], { icon: IconType; hue: string }> = {
  tail: { icon: LuRocket, hue: HUE.violet },
  favorite: { icon: LuShieldCheck, hue: HUE.teal },
  range: { icon: LuBrackets, hue: HUE.blue },
  highroller: { icon: LuGem, hue: HUE.amber },
  active: { icon: LuZap, hue: HUE.blue },
  balanced: { icon: LuScale, hue: HUE.teal },
};

export function StyleBadge({
  style,
  size = 'md',
  showTags = true,
}: {
  style: TraderStyle;
  size?: 'sm' | 'md';
  showTags?: boolean;
}) {
  if (!style.primary) {
    return <span className="text-[12px] text-text-3">Not enough trades to read a style yet.</span>;
  }
  const vis = ARCH_VIS[style.primary.id];
  const Icon = vis.icon;
  const chip = size === 'sm' ? 'gap-1.5 px-2 py-1 text-[11px]' : 'gap-2 px-2.5 py-1.5 text-[12.5px]';
  const iconSize = size === 'sm' ? 12 : 14;

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span
        className={`inline-flex items-center rounded-md font-semibold tracking-tight ${chip}`}
        style={{ color: vis.hue, background: `color-mix(in srgb, ${vis.hue} 14%, transparent)` }}
      >
        <Icon size={iconSize} />
        {style.primary.label}
      </span>
      {showTags &&
        style.tags.map((t) => (
          <span
            key={t.id}
            className="glass-inset inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium text-text-2"
          >
            {t.label}
          </span>
        ))}
    </span>
  );
}
