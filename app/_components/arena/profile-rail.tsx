'use client';

/**
 * ProfileRail — the far-right column. It flips content with the view, exactly
 * like the reference:
 *   · hub    → YOUR profile (identity, your faction, your Points breakdown)
 *   · detail → the selected FACTION's profile (identity, links, aggregates)
 */
import { LuChevronRight, LuUsers, LuCalendar, LuGlobe, LuTrophy, LuCoins, LuFlame } from 'react-icons/lu';
import { num, compact } from '@/lib/format';
import { WalletAvatar } from '../leaderboard/wallet-avatar';
import { FactionGlyph, StatTile, RANK_HUE, sharePct } from './arena-shared';
import { type You, type Faction, getFaction } from '@/lib/arena/data';

export function ProfileRail({
  mode,
  you,
  faction,
  onSelectFaction,
}: {
  mode: 'hub' | 'detail';
  you: You;
  faction?: Faction;
  onSelectFaction: (id: string) => void;
}) {
  if (mode === 'detail' && faction) {
    return <FactionProfile faction={faction} />;
  }
  return <YouProfile you={you} faction={getFaction(you.factionId)} onSelectFaction={onSelectFaction} />;
}

/* ------------------------------------------------------------------ *
 * YOUR profile — identity header (violet-tinted glass, echoing the ref's
 * gradient card), your faction badge, then the per-source Points grid.
 * ------------------------------------------------------------------ */
function YouProfile({
  you,
  faction,
  onSelectFaction,
}: {
  you: You;
  faction?: Faction;
  onSelectFaction: (id: string) => void;
}) {
  const HUE = '#9d92e8';
  return (
    <div className="flex flex-col gap-3">
      {/* Identity */}
      <div
        className="rise relative overflow-hidden rounded-2xl border border-white/[0.06] p-4"
        style={{
          background: `radial-gradient(120% 120% at 50% -20%, color-mix(in srgb, ${HUE} 30%, transparent), transparent 60%), color-mix(in srgb, var(--bg-1) 84%, transparent)`,
        }}
      >
        <div className="relative flex items-center gap-3">
          <WalletAvatar addr={you.addr} size={44} ring={`color-mix(in srgb, ${HUE} 55%, transparent)`} />
          <div className="flex min-w-0 flex-col">
            <span className="flex items-center gap-1.5 truncate text-[15px] font-semibold text-text-1">
              {you.handle}
              <span className="font-mono text-[11px] font-normal text-text-3">{you.id}</span>
            </span>
            <span className="mt-0.5 font-mono text-[20px] leading-none tabular-nums text-text-1">
              {compact(you.points)} <span className="text-[11px] text-text-3">pts</span>
            </span>
          </div>
        </div>
      </div>

      {/* Faction badge → drill into your faction */}
      {faction && (
        <button
          onClick={() => onSelectFaction(faction.id)}
          className="glass-card interactive group flex items-center gap-3 rounded-2xl px-3.5 py-3 text-left"
        >
          <FactionGlyph name={faction.name} hue={faction.hue} size={32} />
          <span className="flex min-w-0 flex-col">
            <span className="eyebrow">Your faction</span>
            <span className="flex items-center gap-1.5 truncate text-[13px] font-medium text-text-1">
              {faction.name}
              <span className="font-mono text-[10px] text-text-3">#{faction.rank}</span>
            </span>
          </span>
          <LuChevronRight
            size={15}
            className="ml-auto flex-none text-text-3 transition-transform group-hover:translate-x-0.5 group-hover:text-accent"
          />
        </button>
      )}

      {/* Per-source Points grid — count + points for each source */}
      <div className="grid grid-cols-2 gap-2">
        {you.stats.flatMap((s) => [
          <StatTile key={`${s.label}-c`} label={s.label} value={num(s.count, 0)} hue={s.hue} />,
          <StatTile key={`${s.label}-p`} label={`${s.label} pts`} value={compact(s.points)} />,
        ])}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * FACTION profile — identity tinted by the faction hue, its links, and the
 * aggregates (members, rank, pool split, Points, volume).
 * ------------------------------------------------------------------ */
function FactionProfile({ faction }: { faction: Faction }) {
  const rankHue = RANK_HUE[faction.rank - 1] ?? 'var(--text-2)';
  return (
    <div className="flex flex-col gap-3">
      {/* Identity */}
      <div
        className="rise relative overflow-hidden rounded-2xl border border-white/[0.06] p-4"
        style={{
          background: `radial-gradient(120% 120% at 50% -20%, color-mix(in srgb, ${faction.hue} 26%, transparent), transparent 60%), color-mix(in srgb, var(--bg-1) 84%, transparent)`,
        }}
      >
        <div className="relative flex flex-col items-center gap-2 text-center">
          <FactionGlyph name={faction.name} hue={faction.hue} size={52} />
          <span className="flex items-center gap-1.5 text-[16px] font-semibold text-text-1">
            {faction.name}
            <span className="font-mono text-[12px] font-normal" style={{ color: rankHue }}>
              #{faction.rank}
            </span>
          </span>
          <span className="font-mono text-[22px] leading-none tabular-nums text-text-1">
            {compact(faction.totalPoints)} <span className="text-[11px] text-text-3">pts</span>
          </span>
        </div>
      </div>

      {/* Aggregates */}
      <div className="grid grid-cols-2 gap-2">
        <StatTile label="X Profile" value={<span className="text-[12px] text-text-1">{faction.handle}</span>} icon={LuGlobe} />
        <StatTile
          label="Website"
          value={<span className="text-[12px] text-text-1">{faction.website ?? '—'}</span>}
        />
        <StatTile label="Member since" value={<span className="text-[12px] text-text-1">{faction.memberSince}</span>} icon={LuCalendar} />
        <StatTile label="Members" value={compact(faction.memberCount)} icon={LuUsers} />
        <StatTile label="Rank" value={`#${faction.rank}`} hue={rankHue} icon={LuTrophy} />
        <StatTile label="Pool share" value={sharePct(faction.poolSharePct)} />
        <StatTile label="Bonus pool" value={compact(faction.bonusPool)} unit="DUSDC" hue="var(--warn)" icon={LuFlame} />
        <StatTile label="Base pool" value={compact(faction.basePool)} unit="DUSDC" icon={LuCoins} />
        <StatTile label="Points" value={compact(faction.totalPoints)} />
        <StatTile label="Volume" value={compact(faction.totalVolume)} unit="DUSDC" />
      </div>
    </div>
  );
}
