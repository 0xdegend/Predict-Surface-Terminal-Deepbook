'use client';

/**
 * UserStatsPanel — the admin's read-only view of the Skew user base and how it's
 * performing. Renders as the "Users & performance" tab body inside AdminConsole, which
 * owns the founder gate and the section intro. Nothing here signs; it's pure reporting.
 *
 * Data: the Skew leaderboard board (counts / volume / net PnL / top traders) plus the
 * resolved trade history (real win-rate + a join-over-time curve). Numbers grow on
 * their own as the builder code gets wired and users trade live — see computeSkewUserStats.
 */
import { useMemo, useState } from 'react';
import {
  LuUsers,
  LuUserCheck,
  LuSprout,
  LuActivity,
  LuTrophy,
  LuTrendingUp,
} from 'react-icons/lu';
import { predictV2Config } from '@/config/predict';
import { useV2Leaderboard } from '@/lib/hooks/use-v2-leaderboard';
import { useNow } from '@/lib/hooks/use-now';
import { legacyHistoryByOwner } from '@/lib/portfolio/legacy-history';
import { computeSkewUserStats, buildJoinCurve } from '@/lib/leaderboard/user-stats';
import { num, compact } from '@/lib/format';
import { LineChart } from '@/app/_components/analytics/charts/line-chart';
import { WalletAvatar } from '../leaderboard/wallet-avatar';
import { TraderName } from '../leaderboard/trader-name';
import { WalletMixCard } from './wallet-mix-card';
import { RewardProgressCard } from './reward-progress-card';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const signedUsd = (n: number) => `${n < 0 ? '-' : '+'}$${num(Math.abs(n), 2)}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

type JoinRange = '1d' | '7d' | '14d' | 'all';
const DAY_MS = 86_400_000;
const JOIN_RANGE_MS: Record<Exclude<JoinRange, 'all'>, number> = {
  '1d': DAY_MS,
  '7d': 7 * DAY_MS,
  '14d': 14 * DAY_MS,
};

export function UserStatsPanel() {
  const { skewRows, skewLoading } = useV2Leaderboard();
  const now = useNow(0);

  const stats = useMemo(
    () => computeSkewUserStats(skewRows, legacyHistoryByOwner(), now),
    [skewRows, now],
  );

  // Join-curve time window. Default to all-time (the running total), with 1d/7d/14d to
  // read how many joined in that window instead.
  const [range, setRange] = useState<JoinRange>('all');
  const windowMs = range === 'all' ? null : JOIN_RANGE_MS[range];
  const curve = useMemo(
    () => buildJoinCurve(stats.joinTimes, windowMs, now),
    [stats.joinTimes, windowMs, now],
  );

  const loading = skewLoading && skewRows.length === 0;

  // Founder gating + the section intro live in AdminConsole (this is only ever rendered
  // inside the "Users & performance" tab). Here we're just the reporting body.
  return (
    <div className="flex flex-col gap-6">
      {/* KPI strip — the user base at a glance. */}
      <div className="glass-card overflow-hidden">
        <div className="grid grid-cols-2 divide-x divide-y divide-line sm:grid-cols-3 lg:grid-cols-6 lg:divide-y-0">
          <Kpi icon={LuUsers} label="Total users" value={loading ? '—' : num(stats.totalUsers, 0)} sub="on the Skew board" hero />
          <Kpi icon={LuUserCheck} label="Traders" value={loading ? '—' : num(stats.tradingUsers, 0)} sub="placed a bet" />
          <Kpi icon={LuSprout} label="Faucet onboards" value={loading ? '—' : num(stats.faucetOnboards, 0)} sub="not yet traded" />
          <Kpi icon={LuActivity} label="Active (7d)" value={loading ? '—' : num(stats.activeUsers7d, 0)} sub="traded this week" />
          <Kpi icon={LuTrendingUp} label="Volume" value={loading ? '—' : `$${compact(stats.totalVolume)}`} sub={`${predictV2Config.quote.symbol} staked`} />
          <Kpi icon={LuTrophy} label="Trades" value={loading ? '—' : num(stats.totalTrades, 0)} sub="bets placed" />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        {/* Join-over-time curve. */}
        <div className="lg:col-span-3">
          <div className="glass-card flex h-full flex-col gap-3 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <span className="eyebrow">Users joining over time</span>
                {!loading && stats.joinTimes.length > 0 && (
                  <span className="flex items-baseline gap-1.5">
                    <span className="font-mono text-[22px] leading-none tabular-nums text-text-1">
                      {range === 'all' ? num(curve.joined, 0) : `+${num(curve.joined, 0)}`}
                    </span>
                    <span className="text-[10px] text-text-3">
                      {range === 'all' ? 'traders total' : `new · last ${curve.windowLabel}`}
                    </span>
                  </span>
                )}
              </div>
              <RangeTabs value={range} onChange={setRange} />
            </div>
            {!loading && stats.joinTimes.length > 0 && curve.joined > 0 ? (
              <LineChart
                points={curve.series}
                height={180}
                yFormat={(v) => num(v, 0)}
                xCaptions={[curve.series[0].label, curve.series[curve.series.length - 1].label]}
              />
            ) : (
              <div className="flex h-44 items-center justify-center">
                <p className="max-w-xs text-center text-[11px] leading-relaxed text-text-3">
                  {stats.joinTimes.length === 0
                    ? 'Not enough history yet. The curve fills in as traders settle their first bets.'
                    : `No new traders joined in the last ${curve.windowLabel}.`}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Win / loss + profitability. */}
        <div className="flex flex-col gap-4 lg:col-span-2">
          <div className="glass-card flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="eyebrow">Win rate</span>
              <span className="text-[10px] text-text-3">
                {loading ? '' : `${num(stats.resolvedPositions, 0)} resolved bets`}
              </span>
            </div>
            {stats.resolvedPositions > 0 ? (
              <>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[26px] leading-none tabular-nums text-up">{pct(stats.winRate)}</span>
                  <span className="text-[11px] text-text-3">won · {pct(stats.lossRate)} lost</span>
                </div>
                {/* win/loss split bar */}
                <div className="flex h-2 w-full overflow-hidden rounded-full bg-white/5">
                  <div className="h-full bg-up" style={{ width: `${stats.winRate * 100}%` }} />
                  <div className="h-full bg-down" style={{ width: `${stats.lossRate * 100}%` }} />
                </div>
                <div className="flex justify-between font-mono text-[11px] tabular-nums text-text-3">
                  <span>{num(stats.wins, 0)} won</span>
                  <span>{num(stats.losses, 0)} lost</span>
                </div>
              </>
            ) : (
              <p className="text-[11px] leading-relaxed text-text-3">No resolved bets yet.</p>
            )}
          </div>

          <div className="glass-card grid grid-cols-2 gap-3 p-4">
            <MiniStat
              label="Realized PnL"
              value={loading ? '—' : signedUsd(stats.realizedPnl)}
              tone={stats.realizedPnl >= 0 ? 'up' : 'down'}
              sub="across users"
            />
            <MiniStat
              label="Profitable"
              value={loading ? '—' : num(stats.netPositiveTraders, 0)}
              sub={`of ${num(stats.tradingUsers, 0)} traders`}
            />
            <MiniStat
              label="Avg PnL"
              value={loading ? '—' : signedUsd(stats.avgNetPnl)}
              tone={stats.avgNetPnl >= 0 ? 'up' : 'down'}
              sub="per trader"
            />
            <MiniStat
              label="Faucet → traded"
              value={loading || stats.faucetTotal === 0 ? '—' : `${num(stats.faucetConverted, 0)}/${num(stats.faucetTotal, 0)}`}
              sub="converted"
            />
          </div>
        </div>
      </div>

      {/* How people sign in (Google vs Slush) + how each converts to a bet. */}
      <WalletMixCard />

      {/* Founding Traders reward — claim progress + treasury health + funding runbook. */}
      <RewardProgressCard />

      {/* Top performing traders. */}
      <div className="glass-card overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <LuTrophy size={14} className="text-accent" />
          <span className="text-[13px] font-medium text-text-1">Top performing traders</span>
          <span className="ml-auto text-[10px] text-text-3">by net PnL</span>
        </div>
        {loading ? (
          <div className="px-4 py-8 text-center text-[12px] text-text-3">Loading…</div>
        ) : stats.topTraders.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-text-3">No traders yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-130 font-mono text-[12px] tabular-nums">
              <thead>
                <tr className="border-b border-line/60 text-left text-[10px] uppercase tracking-wider text-text-3">
                  <Th>#</Th>
                  <Th>Trader</Th>
                  <Th right>Net PnL</Th>
                  <Th right>Trades</Th>
                  <Th right>Volume</Th>
                  <Th right>Points</Th>
                </tr>
              </thead>
              <tbody>
                {stats.topTraders.map((t, i) => (
                  <tr key={t.owner} className="border-b border-line/40 last:border-0">
                    <Td>
                      <span className="text-text-3">{i + 1}</span>
                    </Td>
                    <Td>
                      <a
                        href={`https://suiscan.xyz/${predictV2Config.network}/account/${t.owner}`}
                        target="_blank"
                        rel="noreferrer"
                        title={t.owner}
                        className="inline-flex min-w-0 items-center gap-2 text-text-1 hover:text-accent"
                      >
                        <WalletAvatar addr={t.owner} size={22} ring="rgba(255,255,255,0.12)" />
                        <span className="truncate">
                          <TraderName owner={t.owner} />
                        </span>
                        <span className="hidden text-[10px] text-text-3 sm:inline">{short(t.owner)}</span>
                      </a>
                    </Td>
                    <Td right>
                      <span className={t.netPnl >= 0 ? 'text-up' : 'text-down'}>{signedUsd(t.netPnl)}</span>
                    </Td>
                    <Td right>
                      <span className="text-text-2">{num(t.trades, 0)}</span>
                    </Td>
                    <Td right>
                      <span className="text-text-1">${compact(t.volume)}</span>
                    </Td>
                    <Td right>
                      <span className="text-accent">{num(t.points, 0)}</span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-[10px] leading-relaxed text-text-3">
        All figures are live from on-chain activity and update as users trade. Win rate, realized PnL
        and the join curve fold the current deployment together with the Season&nbsp;1 carryover, so
        the record stays continuous across the redeploy.
      </p>
    </div>
  );
}

/* --------------------------------- pieces -------------------------------- */

/** Segmented time-window picker for the join curve. */
function RangeTabs({ value, onChange }: { value: JoinRange; onChange: (r: JoinRange) => void }) {
  const opts: { key: JoinRange; label: string }[] = [
    { key: '1d', label: '1D' },
    { key: '7d', label: '7D' },
    { key: '14d', label: '14D' },
    { key: 'all', label: 'All' },
  ];
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-line bg-black/20 p-0.5">
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          aria-pressed={value === o.key}
          className={`rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
            value === o.key ? 'bg-(--accent-soft) text-accent' : 'text-text-3 hover:text-text-2'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  sub,
  hero = false,
}: {
  icon: typeof LuUsers;
  label: string;
  value: string;
  sub: string;
  hero?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5 p-4">
      <div className="flex items-center gap-1.5">
        <Icon size={12} className="text-text-3" />
        <span className="eyebrow">{label}</span>
      </div>
      <span className={`font-mono leading-none tabular-nums text-text-1 ${hero ? 'text-[24px]' : 'text-[18px]'}`}>
        {value}
      </span>
      <span className="text-[10px] text-text-3">{sub}</span>
    </div>
  );
}

function MiniStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'up' | 'down';
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="eyebrow">{label}</span>
      <span
        className={`font-mono text-[15px] leading-none tabular-nums ${
          tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text-1'
        }`}
      >
        {value}
      </span>
      <span className="text-[10px] text-text-3">{sub}</span>
    </div>
  );
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <th className={`px-4 py-2.5 font-normal ${right ? 'text-right' : ''}`}>{children}</th>;
}

function Td({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <td className={`px-4 py-3 ${right ? 'text-right' : ''}`}>{children}</td>;
}
