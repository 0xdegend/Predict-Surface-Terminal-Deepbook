'use client';

/**
 * RewardProgressCard — admin view of the Founding Traders reward: how many of the
 * frozen allowlist have claimed, how much DUSDC that has paid out, and whether the
 * reward treasury can still cover what's left. Data from
 * /api/v2/admin/reward-progress (aggregate + public on-chain balances only). Also
 * carries the short "how to fund" runbook so the operator has it in context. See
 * [[founding-traders-reward]].
 */
import { useQuery } from '@tanstack/react-query';
import { LuGift, LuArrowUpRight, LuCircleCheck, LuTriangleAlert } from 'react-icons/lu';
import { num } from '@/lib/format';
import { predictV2Config } from '@/config/predict';

interface RewardProgress {
  campaign: string;
  perClaimDusdc: number;
  eligibleCount: number;
  totalCommittedDusdc: number;
  claimedCount: number;
  paidDusdc: number;
  remainingCount: number;
  remainingCommittedDusdc: number;
  enabled: boolean;
  preview: boolean;
  treasury: {
    configured: boolean;
    address: string | null;
    dusdc: number | null;
    sui: number | null;
    coversRemaining: boolean;
  };
  claimers: { address: string; digest: string | null }[];
  builtAtMs: number;
}

const net = predictV2Config.network;
const TX_URL = (d: string) => `https://suiscan.xyz/${net}/tx/${d}`;
const ADDR_URL = (a: string) => `https://suiscan.xyz/${net}/account/${a}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const sym = predictV2Config.quote.symbol;

export function RewardProgressCard() {
  const { data, isLoading } = useQuery<RewardProgress>({
    queryKey: ['admin', 'reward-progress'],
    queryFn: async ({ signal }) => {
      const res = await fetch('/api/v2/admin/reward-progress', { signal });
      if (!res.ok) throw new Error(`reward-progress ${res.status}`);
      return (await res.json()) as RewardProgress;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const status: { label: string; cls: string } = data?.enabled
    ? { label: 'Live', cls: 'bg-(--accent-soft) text-accent' }
    : data?.preview
      ? { label: 'Preview', cls: 'bg-warn/15 text-warn' }
      : { label: 'Off', cls: 'bg-white/5 text-text-3' };

  const claimed = data?.claimedCount ?? 0;
  const eligible = data?.eligibleCount ?? 0;
  const sharePct = eligible > 0 ? Math.round((claimed / eligible) * 100) : 0;
  const t = data?.treasury;

  return (
    <div className="glass-card flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="eyebrow flex items-center gap-1.5">
            <LuGift size={12} className="text-text-3" /> Founding Traders reward
          </span>
          <span className="text-[10px] text-text-3">
            {num(data?.perClaimDusdc ?? 50, 0)} {sym} each · {num(eligible, 0)} eligible ·{' '}
            {num(data?.totalCommittedDusdc ?? 0, 0)} {sym} committed
          </span>
        </div>
        <span className={`rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${status.cls}`}>
          {status.label}
        </span>
      </div>

      {isLoading ? (
        <div className="flex h-24 items-center justify-center text-[11px] text-text-3">Loading…</div>
      ) : !data ? (
        <p className="text-[11px] text-text-3">Could not load reward progress.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Claim progress */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3 font-mono text-[12px] tabular-nums">
              <span className="text-text-1">
                {num(claimed, 0)}
                <span className="text-text-3"> / {num(eligible, 0)} claimed</span>
                <span className="ml-1.5 text-[10px] text-text-3">({sharePct}%)</span>
              </span>
              <span className="text-text-3">
                <span className="text-up">{num(data.paidDusdc, 0)}</span> {sym} paid
              </span>
            </div>
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-white/5">
              <div className="absolute inset-y-0 left-0 rounded-full bg-up" style={{ width: `${sharePct}%` }} />
            </div>
            <span className="font-mono text-[10px] tabular-nums text-text-3">
              {num(data.remainingCount, 0)} left · {num(data.remainingCommittedDusdc, 0)} {sym} still to pay
            </span>
          </div>

          {/* Treasury health */}
          {t?.configured ? (
            <div className="flex flex-col gap-2 rounded-lg border border-line bg-black/20 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="eyebrow">Reward treasury</span>
                {t.coversRemaining ? (
                  <span className="inline-flex items-center gap-1 text-[10px] font-medium text-up">
                    <LuCircleCheck size={12} /> covers what’s left
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[10px] font-medium text-warn">
                    <LuTriangleAlert size={12} /> top up needed
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3 font-mono text-[12px] tabular-nums">
                <div className="flex flex-col">
                  <span className={`${t.coversRemaining ? 'text-text-1' : 'text-warn'}`}>
                    {t.dusdc == null ? '—' : num(t.dusdc, 2)} {sym}
                  </span>
                  <span className="text-[10px] text-text-3">balance</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-text-1">{t.sui == null ? '—' : num(t.sui, 3)} SUI</span>
                  <span className="text-[10px] text-text-3">for gas + drips</span>
                </div>
              </div>
              {t.address && (
                <a
                  href={ADDR_URL(t.address)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 self-start font-mono text-[10px] text-text-3 transition-colors hover:text-accent"
                >
                  {short(t.address)}
                  <LuArrowUpRight size={11} />
                </a>
              )}
            </div>
          ) : (
            <p className="rounded-lg border border-line bg-black/20 p-3 text-[11px] leading-relaxed text-text-3">
              Reward treasury key not configured. Set <code className="text-text-2">REWARD_TREASURY_PRIVATE_KEY</code>{' '}
              (or reuse the starter-grant treasury) to enable payouts.
            </p>
          )}

          {/* Recent claims */}
          {data.claimers.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="eyebrow">Recent claims</span>
              <div className="flex flex-col gap-1">
                {data.claimers.map((c) => (
                  <div key={c.address} className="flex items-center justify-between gap-2 font-mono text-[11px] tabular-nums">
                    <a href={ADDR_URL(c.address)} target="_blank" rel="noreferrer" className="text-text-2 transition-colors hover:text-accent">
                      {short(c.address)}
                    </a>
                    {c.digest ? (
                      <a href={TX_URL(c.digest)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-text-3 transition-colors hover:text-accent">
                        payout <LuArrowUpRight size={10} />
                      </a>
                    ) : (
                      <span className="text-text-3">claimed</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Funding runbook — in context, so the operator doesn't have to hunt for it. */}
          <details className="group rounded-lg border border-line bg-black/20 p-3">
            <summary className="cursor-pointer list-none text-[11px] font-medium text-text-2 transition-colors hover:text-text-1">
              How to fund the treasury
            </summary>
            <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-4 text-[11px] leading-relaxed text-text-3 marker:text-text-3">
              <li>
                Send DUSDC to the treasury address above until it covers the remaining{' '}
                <span className="text-text-2">{num(data.remainingCommittedDusdc, 0)} {sym}</span>. The
                builder-fee earnings are the source, sweep them with{' '}
                <code className="text-text-2">claim_all_builder_fees</code> into the treasury.
              </li>
              <li>
                Keep a little <span className="text-text-2">SUI</span> in the treasury for its own gas
                and the small drips external (Slush) wallets need to sign their deposit. Testnet SUI is
                free from the faucet.
              </li>
              <li>
                Flip it on with <code className="text-text-2">NEXT_PUBLIC_REWARD_ENABLED=1</code> and
                restart the app. Full steps live in{' '}
                <code className="text-text-2">lib/rewards/RUNBOOK.md</code>.
              </li>
            </ol>
          </details>
        </div>
      )}
    </div>
  );
}
