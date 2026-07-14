'use client';

/**
 * ArenaHeader — the full-width bento header. The looping-video hero spans two
 * rows on the left; the right two columns tile the season economics (prize +
 * countdown) and the identity pair (you + your faction). In detail mode the
 * identity pair flips to the selected faction's identity + key figures, so the
 * same grid reads for both zoom levels. Your/its full stat breakdown lives in the
 * strip below (arena-stats.tsx); the table then spans full width.
 */
import { LuChevronRight } from 'react-icons/lu';
import { compact } from '@/lib/format';
import { WalletAvatar } from '../leaderboard/wallet-avatar';
import { FactionGlyph, RANK_HUE, sharePct } from './arena-shared';
import { ArenaBanner, PrizeTile, CountdownTile } from './arena-hero';
import { type You, type Faction, getFaction } from '@/lib/arena/data';

const YOU_HUE = '#9d92e8'; // the violet identity tint (echoes the reference card)

export function ArenaHeader({
  mode,
  joined,
  onBack,
  onToggleRules,
  showRules,
  you,
  faction,
  onSelectFaction,
}: {
  mode: 'hub' | 'detail';
  joined?: boolean;
  onBack?: () => void;
  onToggleRules: () => void;
  showRules: boolean;
  you: You;
  /** The selected faction in detail mode. */
  faction?: Faction;
  onSelectFaction: (id: string) => void;
}) {
  const yourFaction = getFaction(you.factionId);
  return (
    <div className="grid gap-3 lg:grid-cols-[1.5fr_1fr_1fr] lg:grid-rows-2">
      <ArenaBanner
        mode={mode}
        joined={joined}
        onBack={onBack}
        onToggleRules={onToggleRules}
        showRules={showRules}
        className="lg:col-start-1 lg:row-span-2"
      />
      <PrizeTile className="lg:col-start-2 lg:row-start-1" />
      <CountdownTile className="lg:col-start-2 lg:row-start-2" />

      {mode === 'detail' && faction ? (
        <>
          <FactionIdentityTile faction={faction} className="lg:col-start-3 lg:row-start-1" />
          <FactionMetaTile faction={faction} className="lg:col-start-3 lg:row-start-2" />
        </>
      ) : (
        <>
          <IdentityTile you={you} className="lg:col-start-3 lg:row-start-1" />
          <FactionBadgeTile faction={yourFaction} onSelect={onSelectFaction} className="lg:col-start-3 lg:row-start-2" />
        </>
      )}
    </div>
  );
}

/* ------------------------------- hub tiles ------------------------------- */

function IdentityTile({ you, className = '' }: { you: You; className?: string }) {
  return (
    <div
      className={`rise relative flex flex-col justify-center overflow-hidden rounded-2xl border border-white/[0.06] p-4 sm:p-5 ${className}`}
      style={{
        background: `radial-gradient(120% 120% at 50% -20%, color-mix(in srgb, ${YOU_HUE} 30%, transparent), transparent 60%), color-mix(in srgb, var(--bg-1) 84%, transparent)`,
        animationDelay: '60ms',
      }}
    >
      <div className="relative flex items-center gap-3">
        <WalletAvatar addr={you.addr} size={42} ring={`color-mix(in srgb, ${YOU_HUE} 55%, transparent)`} />
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5 truncate text-[14px] font-semibold text-text-1">
            {you.handle}
            <span className="font-mono text-[11px] font-normal text-text-3">{you.id}</span>
          </span>
          <span className="mt-0.5 font-mono text-[20px] leading-none tabular-nums text-text-1">
            {compact(you.points)} <span className="text-[11px] text-text-3">pts</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function FactionBadgeTile({
  faction,
  onSelect,
  className = '',
}: {
  faction?: Faction;
  onSelect: (id: string) => void;
  className?: string;
}) {
  if (!faction) return <div className={className} />;
  return (
    <button
      onClick={() => onSelect(faction.id)}
      className={`glass-card interactive group flex items-center gap-3 rounded-2xl px-4 py-3 text-left ${className}`}
      style={{ animationDelay: '90ms' }}
    >
      <FactionGlyph name={faction.name} hue={faction.hue} size={36} />
      <span className="flex min-w-0 flex-col">
        <span className="eyebrow">Your faction</span>
        <span className="flex items-center gap-1.5 truncate text-[13px] font-medium text-text-1">
          {faction.name}
          <span className="font-mono text-[10px] text-text-3">#{faction.rank}</span>
        </span>
      </span>
      <LuChevronRight
        size={16}
        className="ml-auto flex-none text-text-3 transition-transform group-hover:translate-x-0.5 group-hover:text-accent"
      />
    </button>
  );
}

/* ----------------------------- detail tiles ------------------------------ */

function FactionIdentityTile({ faction, className = '' }: { faction: Faction; className?: string }) {
  const rankHue = RANK_HUE[faction.rank - 1] ?? 'var(--text-2)';
  return (
    <div
      className={`rise relative flex flex-col justify-center overflow-hidden rounded-2xl border border-white/[0.06] p-4 sm:p-5 ${className}`}
      style={{
        background: `radial-gradient(120% 120% at 50% -20%, color-mix(in srgb, ${faction.hue} 26%, transparent), transparent 60%), color-mix(in srgb, var(--bg-1) 84%, transparent)`,
        animationDelay: '60ms',
      }}
    >
      <div className="relative flex items-center gap-3">
        <FactionGlyph name={faction.name} hue={faction.hue} size={42} />
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5 truncate text-[14px] font-semibold text-text-1">
            {faction.name}
            <span className="font-mono text-[11px] font-normal" style={{ color: rankHue }}>
              #{faction.rank}
            </span>
          </span>
          <span className="mt-0.5 font-mono text-[20px] leading-none tabular-nums text-text-1">
            {compact(faction.totalPoints)} <span className="text-[11px] text-text-3">pts</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function FactionMetaTile({ faction, className = '' }: { faction: Faction; className?: string }) {
  return (
    <div className={`glass-card rise flex items-center justify-around gap-2 rounded-2xl p-4 sm:p-5 ${className}`} style={{ animationDelay: '90ms' }}>
      <MiniStat label="Members" value={compact(faction.memberCount)} />
      <span className="h-8 w-px flex-none bg-white/[0.06]" />
      <MiniStat label="Pool share" value={sharePct(faction.poolSharePct)} />
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex min-w-0 flex-col items-center gap-1 text-center">
      <span className="eyebrow">{label}</span>
      <span className="font-mono text-[16px] leading-none tabular-nums text-text-1">{value}</span>
    </span>
  );
}
