'use client';

/**
 * FactionDetail — one faction's members ("Degens"), ranked by Points. Each row
 * shows the member's share of the faction's Points and the DUSDC that share
 * projects to — making the second level of the payout model concrete:
 *   memberPrize = (memberPoints / factionPoints) × faction.totalPool
 */
import { LuCoins } from 'react-icons/lu';
import { num, compact } from '@/lib/format';
import { WalletAvatar } from '../leaderboard/wallet-avatar';
import { RankMedal, sharePct } from './arena-shared';
import type { Faction } from '@/lib/arena/data';

const COLS = 'grid-cols-[2rem_1fr_6rem_5.5rem] sm:grid-cols-[2.5rem_1fr_7rem_7rem_6rem]';

export function FactionDetail({ faction }: { faction: Faction }) {
  return (
    <div className="flex flex-col gap-3">
      {/* Context line — teaches the two-level split. */}
      <p className="flex items-start gap-2 px-1 text-[12px] leading-relaxed text-text-3">
        <LuCoins size={13} className="mt-px flex-none" style={{ color: 'var(--warn)' }} />
        <span>
          Members ranked by Points. Each member&apos;s prize is their share of{' '}
          <span className="text-text-2">{faction.name}</span>&apos;s Points times the faction&apos;s{' '}
          <span className="font-mono text-text-2">{compact(faction.totalPool)} DUSDC</span> pool.
        </span>
      </p>

      <div className="glass-card overflow-hidden">
        <div className={`head-divider grid ${COLS} items-center gap-2 px-3 py-2.5 text-[10px] font-medium uppercase tracking-wider text-text-3 sm:px-4`}>
          <span className="text-right">#</span>
          <span>Degen</span>
          <span className="hidden text-right sm:block">Volume</span>
          <span className="text-right">Points</span>
          <span className="text-right">Est. prize</span>
        </div>

        <div className="rows-divided">
          {faction.members.map((m, i) => (
            <div
              key={m.addr}
              className={`grid ${COLS} items-center gap-2 px-3 py-3 font-mono text-[12px] tabular-nums sm:px-4 ${
                i === 0 ? 'bg-white/[0.015]' : ''
              }`}
            >
              {/* Rank */}
              <span className="flex justify-end">
                <RankMedal rank={i + 1} />
              </span>

              {/* Degen */}
              <span className="flex min-w-0 items-center gap-2.5">
                <WalletAvatar addr={m.addr} size={26} ring="rgba(255,255,255,0.08)" />
                <span className="truncate font-sans text-[13px] text-text-1">{m.name}</span>
              </span>

              {/* Volume */}
              <span className="hidden text-right text-text-2 sm:block">{compact(m.volume)}</span>

              {/* Points + share of faction */}
              <span className="flex flex-col items-end gap-0.5">
                <span className="text-[13px] text-[var(--accent)]">{compact(m.points)}</span>
                <span className="text-[10px] text-text-3">{sharePct(m.share)}</span>
              </span>

              {/* Est. prize */}
              <span className="text-right text-text-1">
                {num(m.prize, 0)}
                <span className="ml-1 text-[9px] text-text-3">DUSDC</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
