'use client';

/**
 * Competitions — a PREVIEW of Skew's seasonal trading races. Traders compete
 * over a fixed window (ranked by Points, the same metric the live leaderboard
 * already computes); the top finishers split a DUSDC prize pool funded by the
 * Skew fee treasury. Not live yet: the entrants, pool and standings are
 * illustrative, but the countdown is a real ticking clock to the next Monday so
 * the page feels alive. 100% client, no data, no wallet.
 */
import {
  LuSwords,
  LuTrophy,
  LuCrown,
  LuCoins,
  LuUsers,
  LuFlame,
  LuLock,
  LuTarget,
  LuCalendarClock,
} from 'react-icons/lu';
import { num, compact } from '@/lib/format';
import { useMounted } from '@/lib/hooks/use-mounted';
import { WalletAvatar } from '../leaderboard/wallet-avatar';
import { HUE } from '../ui/metric';
import {
  RewardsHeader,
  FundingNote,
  CrossLink,
  useNow,
  nextMondayUTC,
  countdownParts,
} from './shared';

const PRIZE_POOL = 2500; // illustrative DUSDC
const ENTRANTS = 128;

const RANK_HUE = ['#e8c14e', '#c2cbd4', '#c08a5a']; // gold / silver / bronze

// Illustrative standings. Deterministic fake addresses feed the real
// WalletAvatar so the podium looks like the live leaderboard's, not a mock.
interface Standing {
  addr: string;
  name: string;
  points: number;
  prize: number;
}
const STANDINGS: Standing[] = [
  { addr: '0x7a3f9c12bd4e8f6a1029384756abcdef0011223344556677889900aabbccddee', name: 'vol.sui', points: 48210, prize: 1000 },
  { addr: '0x2b8e1d77aa90ffcc5511ee229f3a4b5c00112233445566778899aabbccddeeff', name: 'skewmaster', points: 41980, prize: 625 },
  { addr: '0x5fc0a9e377112233445566778899aabbccddeeff00112233445566778899aabb', name: 'theta.gang', points: 37640, prize: 375 },
  { addr: '0x9d12ee4488bb33cc77aa5566bb99001122334455667788990a1b2c3d4e5f6a7b', name: '0xnocturne', points: 29110, prize: 100 },
  { addr: '0x44aa77cc1199ee22dd8833005566778899aabbccddeeff00112233445566aa11', name: 'gammahunter', points: 24870, prize: 100 },
  { addr: '0x118822aa44ff66cc99dd5577aabb001122334455667788990a1b2c3d4e5f8899', name: 'pico.sol', points: 19330, prize: 100 },
];

const PRIZE_SPLIT = [
  { place: '1st', pct: 40 },
  { place: '2nd', pct: 25 },
  { place: '3rd', pct: 15 },
  { place: '4th–10th', pct: 20 },
];

export function CompetitionsPanel() {
  const mounted = useMounted();
  const now = useNow(1000);
  // Anchor the countdown to a real upcoming Monday so the clock genuinely ticks.
  const target = mounted ? nextMondayUTC(now) : 0;
  const parts = countdownParts(target - now);

  const podium = STANDINGS.slice(0, 3);
  const rest = STANDINGS.slice(3);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-5">
      <RewardsHeader
        icon={LuSwords}
        title="Competitions"
        blurb="Seasonal trading races where the best traders compete head-to-head. Climb the ranks over the season window and the top finishers split a DUSDC prize pool — funded by the community's trading fees."
      />

      {/* Season hero */}
      <div className="podium-card rise relative overflow-hidden rounded-2xl p-5 sm:p-6" style={{ ['--rank-hue' as string]: HUE.amber }}>
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          {/* left: identity + pool */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="eyebrow">Season 01</span>
              <span
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                style={{ color: 'var(--warn)', background: 'var(--warn-soft)' }}
              >
                <LuFlame size={11} /> Genesis
              </span>
            </div>
            <h2 className="text-[26px] font-semibold leading-none tracking-tight text-text-1">
              The Genesis Cup
            </h2>
            <div className="flex items-end gap-2.5">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ color: HUE.amber, background: `color-mix(in srgb, ${HUE.amber} 14%, transparent)` }}>
                <LuCoins size={20} />
              </span>
              <div>
                <span className="eyebrow">Prize pool</span>
                <div className="font-mono text-[28px] leading-none tracking-tight text-text-1 tabular-nums">
                  {num(PRIZE_POOL, 0)}
                  <span className="ml-1.5 text-[13px] text-text-3">DUSDC</span>
                </div>
              </div>
            </div>
            <div className="mt-1 flex items-center gap-4 text-[11px] text-text-3">
              <span className="inline-flex items-center gap-1.5">
                <LuUsers size={13} /> {num(ENTRANTS, 0)} entrants
              </span>
              <span className="inline-flex items-center gap-1.5">
                <LuTrophy size={13} /> Ranked by Points
              </span>
            </div>
          </div>

          {/* right: live countdown */}
          <div className="flex flex-col items-start gap-2.5 lg:items-end">
            <span className="eyebrow inline-flex items-center gap-1.5">
              <LuCalendarClock size={12} /> Season starts in
            </span>
            <div className="flex items-center gap-2 font-mono tabular-nums">
              <TimeBlock value={mounted ? parts.d : '--'} unit="days" />
              <Colon />
              <TimeBlock value={mounted ? parts.h : '--'} unit="hrs" />
              <Colon />
              <TimeBlock value={mounted ? parts.m : '--'} unit="min" />
              <Colon />
              <TimeBlock value={mounted ? parts.s : '--'} unit="sec" />
            </div>
          </div>
        </div>
      </div>

      {/* Prize split */}
      <div className="glass-card mt-3 grid grid-cols-2 gap-2.5 p-2.5 font-mono tabular-nums sm:grid-cols-4">
        {PRIZE_SPLIT.map((p) => (
          <div key={p.place} className="glass-inset flex flex-col gap-1 px-3 py-2.5">
            <span className="eyebrow">{p.place}</span>
            <span className="text-[15px] leading-none text-text-1">
              {num((PRIZE_POOL * p.pct) / 100, 0)}
              <span className="ml-1 text-[10px] text-text-3">DUSDC</span>
            </span>
            <span className="text-[10px] text-text-3">{p.pct}% of pool</span>
          </div>
        ))}
      </div>

      {/* Podium preview */}
      <div className="mt-6 mb-3 flex items-center gap-2">
        <h3 className="text-[14px] font-semibold tracking-tight text-text-1">Projected podium</h3>
        <span className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-widest" style={{ color: 'var(--warn)', background: 'var(--warn-soft)' }}>
          Preview
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {podium.map((s, i) => (
          <PodiumCard key={s.addr} s={s} rank={i} />
        ))}
      </div>

      {/* Standings preview — frosted, locked */}
      <div className="glass-card relative mt-3 overflow-hidden">
        <div className="head-divider grid grid-cols-[2rem_1fr_5rem_5rem] items-center gap-2 px-4 py-3 text-[10px] font-medium uppercase tracking-wider text-text-3 sm:grid-cols-[2.5rem_1fr_7rem_6rem]">
          <span className="text-right">#</span>
          <span>Trader</span>
          <span className="text-right">Points</span>
          <span className="text-right">Prize</span>
        </div>
        <div className="rows-divided">
          {rest.map((s, idx) => (
            <div
              key={s.addr}
              className="grid grid-cols-[2rem_1fr_5rem_5rem] items-center gap-2 px-4 py-3.5 font-mono text-[12px] tabular-nums sm:grid-cols-[2.5rem_1fr_7rem_6rem]"
            >
              <span className="text-right font-semibold text-text-3">{idx + 4}</span>
              <span className="flex min-w-0 items-center gap-2.5">
                <WalletAvatar addr={s.addr} size={22} ring="rgba(255,255,255,0.08)" />
                <span className="truncate text-text-1">{s.name}</span>
              </span>
              <span className="text-right font-semibold text-[var(--accent)]">{num(s.points, 0)}</span>
              <span className="text-right text-text-2">+{num(s.prize, 0)}</span>
            </div>
          ))}
        </div>
        {/* fade-to-locked overlay on the tail of the table */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-24 items-end justify-center bg-gradient-to-t from-[var(--bg-1)] via-[var(--bg-1)]/80 to-transparent">
          <span className="mb-3 inline-flex items-center gap-1.5 text-[11px] font-medium text-text-3">
            <LuLock size={12} /> Full standings unlock when the season goes live
          </span>
        </div>
      </div>

      <FundingNote />

      <CrossLink
        href="/quests"
        icon={LuTarget}
        eyebrow="Also coming"
        title="Earn rewards from solo trading quests"
      />
    </div>
  );
}

function PodiumCard({ s, rank }: { s: Standing; rank: number }) {
  const hue = RANK_HUE[rank];
  return (
    <div
      className={`podium-card rise relative flex flex-col items-center gap-3 rounded-2xl p-5 ${rank === 0 ? 'champion sm:-mt-2' : ''}`}
      style={{ ['--rank-hue' as string]: hue, animationDelay: `${rank * 60}ms` }}
    >
      <div className="relative">
        <WalletAvatar addr={s.addr} size={rank === 0 ? 56 : 48} ring={`color-mix(in srgb, ${hue} 60%, transparent)`} />
        {rank === 0 && (
          <LuCrown
            size={18}
            className="absolute -top-3 left-1/2 -translate-x-1/2"
            style={{ color: hue }}
          />
        )}
      </div>
      <div className="flex flex-col items-center gap-0.5">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-widest" style={{ color: hue }}>
          {rank + 1}
          {rank === 0 ? 'st' : rank === 1 ? 'nd' : 'rd'}
        </span>
        <span className="max-w-full truncate text-[14px] font-semibold tracking-tight text-text-1">{s.name}</span>
      </div>
      <div className="flex w-full flex-col gap-1.5 font-mono tabular-nums">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-text-3">Points</span>
          <span className="font-semibold text-[var(--accent)]">{compact(s.points)}</span>
        </div>
        <div className="hairline-fade" />
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-text-3">Prize</span>
          <span className="font-semibold text-text-1">
            {num(s.prize, 0)}
            <span className="ml-1 text-[10px] text-text-3">DUSDC</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function TimeBlock({ value, unit }: { value: string; unit: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="glass-inset flex h-11 min-w-11 items-center justify-center rounded-lg px-2 text-[22px] leading-none text-text-1">
        {value}
      </span>
      <span className="text-[9px] uppercase tracking-[0.14em] text-text-3">{unit}</span>
    </div>
  );
}

function Colon() {
  return <span className="pb-4 text-[18px] text-text-3">:</span>;
}
