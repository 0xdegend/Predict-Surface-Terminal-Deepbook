'use client';

/**
 * AdminConsole — the founder console shell. The page used to stack two full, equally
 * dense consoles (treasury tooling + user analytics) in one long scroll. This splits
 * them into tabs behind a single always-on summary ribbon, so it's one screen per
 * concern. Pure chrome + gating; the panels it hosts own their own data and actions.
 */
import { useMemo, useState } from 'react';
import { LuCoins, LuWallet, LuUsers, LuTrophy, LuShieldCheck, LuPercent } from 'react-icons/lu';
import { isAdminAddress } from '@/config/predict';
import { useMounted } from '@/lib/hooks/use-mounted';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useBuilderFeeSummary } from '@/lib/hooks/use-builder-code';
import { useV2Leaderboard } from '@/lib/hooks/use-v2-leaderboard';
import { useNow } from '@/lib/hooks/use-now';
import { computeSkewUserStats } from '@/lib/leaderboard/user-stats';
import { legacyHistoryByOwner } from '@/lib/portfolio/legacy-history';
import { num } from '@/lib/format';
import { BuilderCodePanel } from './builder-code-panel';
import { SkewFeePanel } from './skew-fee-panel';
import { UserStatsPanel } from './user-stats-panel';

type Tab = 'fees' | 'skew' | 'users';

const TABS: { key: Tab; label: string; icon: typeof LuCoins; blurb: string }[] = [
  {
    key: 'fees',
    label: 'Builder fees',
    icon: LuCoins,
    blurb:
      'The protocol pays an add-on builder fee on every open and early close made by an account attributed to Skew. It accrues on-chain until you sweep it.',
  },
  {
    key: 'skew',
    label: 'Skew fee',
    icon: LuPercent,
    blurb:
      'The Skew fee: a percentage of each bet, charged on-chain on top of the builder fee. Set the live rate here and see what it earns against your real volume. Instant-trading (session) bets aren’t charged it yet.',
  },
  {
    key: 'users',
    label: 'Users & performance',
    icon: LuUsers,
    blurb:
      'Who’s trading through Skew and how the book is doing. Counts come from the Skew board; win rate and the join curve come from resolved trade history.',
  },
];

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function AdminConsole() {
  const mounted = useMounted();
  const acct = usePredictAccountV2();
  const [tab, setTab] = useState<Tab>('fees');

  if (!mounted) return null;

  // Gate once, here, so neither the summary ribbon nor the tabs leak to a stranger who
  // guessed the URL. Ownership of the fee code is still enforced on-chain (assert_owner);
  // this is only the courtesy layer, and it keeps deployment details out of view.
  if (!acct.owner) {
    return <Gate>Connect the team wallet to continue.</Gate>;
  }
  if (!isAdminAddress(acct.owner)) {
    return (
      <Gate icon>
        This page is for the Skew team. The connected wallet doesn&rsquo;t have access.
      </Gate>
    );
  }

  const active = TABS.find((t) => t.key === tab)!;

  return (
    <div className="flex flex-col gap-6 pt-6">
      <SummaryBar />

      {/* Section switch + the active section's one-line context. */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-0.5 self-start rounded-lg border border-line p-0.5">
          {TABS.map((t) => {
            const on = t.key === tab;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                aria-pressed={on}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors ${
                  on ? 'bg-white/6 text-text-1' : 'text-text-3 hover:text-text-2'
                }`}
              >
                <t.icon size={13} className={on ? 'text-accent' : ''} />
                {t.label}
              </button>
            );
          })}
        </div>
        <p className="max-w-2xl text-[12px] leading-relaxed text-text-3">{active.blurb}</p>
      </div>

      {tab === 'fees' ? <BuilderCodePanel /> : tab === 'skew' ? <SkewFeePanel /> : <UserStatsPanel />}
    </div>
  );
}

/* --------------------------------- summary -------------------------------- */

/** The always-on headline row: money on the left, users on the right. Reads from the
 *  same hooks the tabs use (queries dedupe), so it never drifts from the detail. */
function SummaryBar() {
  const fee = useBuilderFeeSummary();
  const { skewRows, skewLoading } = useV2Leaderboard();
  const now = useNow(0);
  const stats = useMemo(
    () => computeSkewUserStats(skewRows, legacyHistoryByOwner(), now),
    [skewRows, now],
  );

  const usersLoading = skewLoading && skewRows.length === 0;

  return (
    <div className="glass-card overflow-hidden">
      <div className="grid grid-cols-2 divide-x divide-y divide-line sm:grid-cols-4 sm:divide-y-0">
        <SummaryCell
          icon={LuCoins}
          label="Lifetime fees"
          value={fee.isLoading ? '—' : usd(fee.lifetime)}
        />
        <SummaryCell
          icon={LuWallet}
          label="Unclaimed now"
          value={fee.isLoading ? '—' : usd(fee.unclaimed)}
          accent={fee.unclaimed > 0}
        />
        <SummaryCell
          icon={LuUsers}
          label="Total users"
          value={usersLoading ? '—' : num(stats.totalUsers, 0)}
        />
        <SummaryCell
          icon={LuTrophy}
          label="Win rate"
          value={usersLoading || stats.resolvedPositions === 0 ? '—' : pct(stats.winRate)}
        />
      </div>
    </div>
  );
}

function SummaryCell({
  icon: Icon,
  label,
  value,
  accent = false,
}: {
  icon: typeof LuCoins;
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-white/[0.02] text-text-3">
        <Icon size={14} />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="eyebrow">{label}</span>
        <span
          className={`font-mono text-[16px] leading-none tabular-nums ${accent ? 'text-accent' : 'text-text-1'}`}
        >
          {value}
        </span>
      </div>
    </div>
  );
}

/* ---------------------------------- gate ---------------------------------- */

function Gate({ children, icon = false }: { children: React.ReactNode; icon?: boolean }) {
  return (
    <div className="mx-auto max-w-lg pt-6">
      <div className="glass-card p-4">
        {icon ? (
          <div className="flex items-start gap-3">
            <LuShieldCheck size={18} className="mt-0.5 shrink-0 text-text-3" />
            <p className="text-[12px] leading-relaxed text-text-3">{children}</p>
          </div>
        ) : (
          <p className="text-[12px] text-text-3">{children}</p>
        )}
      </div>
    </div>
  );
}
