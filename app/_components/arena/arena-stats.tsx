'use client';

/**
 * ArenaStatStrip — the full-width metrics strip under the bento header. It flips
 * with the view, exactly like the old rail did:
 *   · hub    → YOUR per-source Points breakdown (count + points per source).
 *   · detail → the selected faction's aggregates.
 * Laid out as a horizontal grid so it fills the width instead of stacking in a
 * narrow rail (the reason we moved off the rail — no more empty right column).
 */
import { LuUsers, LuTrophy, LuCoins, LuFlame, LuGlobe, LuCalendar } from 'react-icons/lu';
import { num, compact } from '@/lib/format';
import { StatTile, RANK_HUE, sharePct } from './arena-shared';
import type { You, Faction } from '@/lib/arena/data';

export function ArenaStatStrip({ mode, you, faction }: { mode: 'hub' | 'detail'; you: You; faction?: Faction }) {
  if (mode === 'detail' && faction) {
    const rankHue = RANK_HUE[faction.rank - 1] ?? 'var(--text-2)';
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Members" value={compact(faction.memberCount)} icon={LuUsers} />
        <StatTile label="Rank" value={`#${faction.rank}`} hue={rankHue} icon={LuTrophy} />
        <StatTile label="Pool share" value={sharePct(faction.poolSharePct)} />
        <StatTile label="Bonus pool" value={compact(faction.bonusPool)} unit="DUSDC" hue="var(--warn)" icon={LuFlame} />
        <StatTile label="Base pool" value={compact(faction.basePool)} unit="DUSDC" icon={LuCoins} />
        <StatTile label="Points" value={compact(faction.totalPoints)} />
        <StatTile label="Volume" value={compact(faction.totalVolume)} unit="DUSDC" />
        <StatTile label="X Profile" value={<span className="text-[12px] text-text-1">{faction.handle}</span>} icon={LuGlobe} />
        <StatTile label="Website" value={<span className="text-[12px] text-text-1">{faction.website ?? '—'}</span>} />
        <StatTile label="Member since" value={<span className="text-[12px] text-text-1">{faction.memberSince}</span>} icon={LuCalendar} />
      </div>
    );
  }

  // Hub: your per-source breakdown — one grouped tile per source (count + points)
  // for a clean four-across strip that fills the width without cramping labels.
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {you.stats.map((s) => (
        <SourceTile key={s.label} label={s.label} count={s.count} points={s.points} hue={s.hue} />
      ))}
    </div>
  );
}

/** One source's contribution: its count (hued) and the Points it earned. */
function SourceTile({ label, count, points, hue }: { label: string; count: number; points: number; hue: string }) {
  return (
    <div className="glass-inset flex items-center justify-between gap-3 px-3.5 py-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="eyebrow">{label}</span>
        <span className="font-mono text-[20px] leading-none tabular-nums" style={{ color: hue }}>
          {num(count, 0)}
        </span>
      </div>
      <div className="flex flex-none flex-col items-end gap-1.5">
        <span className="eyebrow">Points</span>
        <span className="font-mono text-[14px] leading-none tabular-nums text-text-1">{compact(points)}</span>
      </div>
    </div>
  );
}
