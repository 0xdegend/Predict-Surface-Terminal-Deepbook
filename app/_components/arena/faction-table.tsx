'use client';

/**
 * FactionTable — the hub leaderboard: every faction ranked, with the two-part
 * prize split shown per row (Bonus = rank-weighted, Base = points-proportional).
 * Clicking a row drills into that faction's members. Search filters the list;
 * "Apply" / "Refer" are the founding + growth CTAs (styled preview, no-op).
 */
import { useState } from 'react';
import { LuSearch, LuUserPlus, LuGift, LuChevronRight, LuShare2 } from 'react-icons/lu';
import { compact } from '@/lib/format';
import { FactionGlyph, RankMedal, PoolCell, sharePct } from './arena-shared';
import type { Faction } from '@/lib/arena/data';

// Mobile: Rank · Faction · Bonus · chevron. sm+: adds Members, Base, share action.
const COLS = 'grid-cols-[2rem_1fr_5.5rem_1.75rem] sm:grid-cols-[2.5rem_1fr_5rem_7rem_7rem_4.5rem]';

export function FactionTable({
  factions,
  youFactionId,
  onSelect,
}: {
  factions: Faction[];
  youFactionId: string;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const rows = q ? factions.filter((f) => f.name.toLowerCase().includes(q) || f.handle.toLowerCase().includes(q)) : factions;

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="glass-inset flex flex-1 items-center gap-2 rounded-lg px-3 py-2">
          <LuSearch size={14} className="flex-none text-text-3" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all factions…"
            className="w-full bg-transparent text-[13px] text-text-1 placeholder:text-text-3 focus:outline-none"
          />
        </label>
        <div className="flex items-center gap-2">
          <button className="ctrl-soft inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-medium text-text-2">
            <LuGift size={14} /> Refer and earn
          </button>
          <button className="glass-inset inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-medium text-text-1 transition-colors hover:border-(--accent-line)">
            <LuUserPlus size={14} className="text-accent" /> Apply for a faction
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="glass-card overflow-hidden">
        <div className={`head-divider grid ${COLS} items-center gap-2 px-3 py-2.5 text-[10px] font-medium uppercase tracking-wider text-text-3 sm:px-4`}>
          <span className="text-right">#</span>
          <span>Faction</span>
          <span className="hidden text-right sm:block">Members</span>
          <span className="text-right">Bonus Pool</span>
          <span className="hidden text-right sm:block">Base Pool</span>
          <span className="hidden text-right sm:block">Actions</span>
        </div>

        <div className="rows-divided">
          {rows.length === 0 ? (
            <div className="px-4 py-12 text-center text-[13px] text-text-2">No factions match &ldquo;{query}&rdquo;.</div>
          ) : (
            rows.map((f) => {
              const isYou = f.id === youFactionId;
              return (
                <button
                  key={f.id}
                  onClick={() => onSelect(f.id)}
                  className={`grid w-full ${COLS} items-center gap-2 px-3 py-3 text-left transition-colors hover:bg-white/[0.02] sm:px-4 ${
                    isYou ? 'bg-[var(--accent-soft)]' : ''
                  }`}
                >
                  {/* Rank */}
                  <span className="flex justify-end">
                    <RankMedal rank={f.rank} />
                  </span>

                  {/* Faction */}
                  <span className="flex min-w-0 items-center gap-2.5">
                    <FactionGlyph name={f.name} hue={f.hue} size={30} />
                    <span className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-1.5 truncate text-[13px] font-medium text-text-1">
                        {f.name}
                        {isYou && <span className="text-[10px] text-[var(--accent)]">you</span>}
                      </span>
                      <span className="font-mono text-[10px] tabular-nums text-text-3">
                        {sharePct(f.poolSharePct)} of pool
                      </span>
                    </span>
                  </span>

                  {/* Members */}
                  <span className="hidden text-right font-mono text-[12px] tabular-nums text-text-2 sm:block">
                    {compact(f.memberCount)}
                  </span>

                  {/* Bonus Pool — rank-weighted */}
                  <span className="flex justify-end">
                    <PoolCell amount={f.bonusPool} sub={`${sharePct(f.bonusSharePct)}`} />
                  </span>

                  {/* Base Pool — points-proportional, with a small live drift */}
                  <span className="hidden justify-end sm:flex">
                    <PoolCell
                      amount={f.basePool}
                      sub={<span className="text-[var(--up)]">↗ {sharePct(f.baseDeltaPct, 4)}</span>}
                    />
                  </span>

                  {/* Actions */}
                  <span className="flex items-center justify-end gap-1">
                    <span
                      role="button"
                      tabIndex={-1}
                      onClick={(e) => e.stopPropagation()}
                      className="hidden h-7 w-7 items-center justify-center rounded-md text-text-3 transition-colors hover:bg-white/[0.05] hover:text-text-1 sm:inline-flex"
                      aria-label="Share faction"
                    >
                      <LuShare2 size={13} />
                    </span>
                    <LuChevronRight size={15} className="flex-none text-text-3" />
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
