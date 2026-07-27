'use client';

/**
 * V2VaultOverview — the read side of the vault (legacy vault/risk role), in the
 * legacy glass language: a frosted bento of icon-chip stat tiles (pool value
 * hero with the accent wash, share price, shares, idle, queue), the pool-
 * composition meter, and the last keeper flush. Blends two honest sources:
 * on-chain views via simulate and the indexer's `/vaults/:id/state` (full pool
 * NAV incl. capital deployed to open markets — share price = NAV / shares).
 */
import type { IconType } from 'react-icons';
import {
  LuLandmark,
  LuCoins,
  LuLayers,
  LuWalletMinimal,
  LuClock,
  LuChartPie,
} from 'react-icons/lu';
import { useVaultV2 } from '@/lib/hooks/use-vault-v2';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useNow } from '@/lib/hooks/use-now';
import { fromQuote } from '@/config/scale';
import { quote as fmtQuote, compact, ago } from '@/lib/format';
import { predictV2Config } from '@/config/predict';
import { HUE, IconChip } from '../ui/metric';
import { InfoTip } from '../ui/info-tip';

export function V2VaultOverview() {
  const { vault, nav } = useVaultV2();
  const acct = usePredictAccountV2();
  const now = useNow(0);

  const cur = nav?.current ?? null;
  const flush = nav?.latest_flush ?? null;

  const poolValue = cur ? fromQuote(cur.pool_value) : null;
  const deployed = cur ? fromQuote(cur.active_market_nav) : 0;
  const sharePrice =
    cur && Number(cur.total_supply) > 0 ? Number(cur.pool_value) / Number(cur.total_supply) : null;

  const idle = vault ? fromQuote(vault.idleBalance) : cur ? fromQuote(cur.idle_balance_after) : 0;
  const reserve = vault ? fromQuote(vault.protocolReserve) : 0;
  const feeInc = vault ? fromQuote(vault.feeIncentiveReserve) : 0;
  const poolTotal = idle + deployed;
  const idlePct = poolTotal > 0 ? (idle / poolTotal) * 100 : 0;

  const yourShares = fromQuote(acct.plpBalanceBase);
  const yourValue = sharePrice != null ? yourShares * sharePrice : null;

  return (
    <div className="flex flex-col gap-5">
      {/* Vault metrics — bento: a balanced grid of stat cards, like the portfolio */}
      <div className="glass-card grid grid-cols-2 gap-2.5 p-2.5 font-mono tabular-nums">
        {/* Pool value — hero (larger number + accent wash) */}
        <div className="glass-inset relative col-span-2 flex flex-col gap-3 overflow-hidden p-4">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(120% 90% at 0% 0%, var(--accent-soft), transparent 60%)' }}
          />
          <div className="relative flex items-center gap-2.5">
            <IconChip icon={LuLandmark} color={HUE.teal} size={30} />
            <span className="eyebrow">Pool value</span>
            <InfoTip label="Pool value">
              Everything the vault holds — idle money plus the capital currently backing open
              bets. Your share of it is what your vault shares are worth.
            </InfoTip>
          </div>
          <div className="relative flex flex-col gap-2">
            <span className="text-[34px] leading-none tracking-tight text-text-1">
              {poolValue != null ? <Money value={poolValue} /> : '…'}
            </span>
            <span className="text-[10px] uppercase tracking-[0.12em] text-text-3">
              {predictV2Config.quote.symbol} · backs every open position
            </span>
          </div>
        </div>

        <SmallStat
          icon={LuCoins}
          color={HUE.amber}
          label="Share price"
          value={sharePrice != null ? `${sharePrice.toFixed(4)}` : '…'}
          sub="per PLP share"
        />
        <SmallStat
          icon={LuLayers}
          color={HUE.blue}
          label="Total shares"
          value={vault ? <Money value={fromQuote(vault.plpTotalSupply)} /> : '…'}
          sub="PLP outstanding"
        />
        <SmallStat
          icon={LuWalletMinimal}
          color={HUE.violet}
          label="Idle liquidity"
          value={vault || cur ? <Money value={idle} /> : '…'}
          sub={`${predictV2Config.quote.symbol} on hand`}
        />
        <SmallStat
          icon={LuClock}
          color={HUE.coral}
          label="In the queue"
          info="Deposits and withdrawals wait here until the next vault update fills them at the live share price."
          value={vault ? `${vault.supplyPending} · ${vault.withdrawPending}` : '…'}
          sub="deposits · withdrawals"
        />

        {/* Your position — the feature tile, accent-washed like the portfolio's */}
        <div className="glass-inset relative col-span-2 flex flex-col gap-2 overflow-hidden p-4">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(120% 90% at 100% 0%, var(--accent-soft), transparent 60%)' }}
          />
          <div className="relative flex items-center gap-2">
            <IconChip icon={LuChartPie} color={HUE.teal} size={22} />
            <span className="eyebrow">Your position</span>
          </div>
          <span className="relative text-[20px] leading-none tracking-tight text-accent">
            {acct.wrapperExists && yourValue != null ? <Money value={yourValue} /> : '—'}{' '}
            <span className="text-[11px] text-text-3">{predictV2Config.quote.symbol}</span>
          </span>
          <span className="relative text-[10px] leading-relaxed text-text-3">
            {acct.wrapperExists
              ? `${fmtQuote(yourShares)} PLP shares · value moves with the pool`
              : 'Connect and create a trading account to provide liquidity'}
          </span>
        </div>
      </div>

      {/* Pool composition — idle vs deployed, in a frosted section */}
      <div className="glass-card flex flex-col gap-3 p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-text-2">
            <span className="h-3 w-px bg-accent/70" />
            Pool composition
          </h2>
          <span className="font-mono text-[11px] tabular-nums text-text-3">
            <Money value={poolTotal} /> {predictV2Config.quote.symbol}
          </span>
        </div>

        <div className="glass-inset flex h-2.5 overflow-hidden rounded-full p-0">
          <span className="h-full bg-up/70" style={{ width: `${idlePct}%` }} />
          <span className="h-full flex-1 bg-white/15" />
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-1.5 font-mono text-[10px] tabular-nums text-text-3">
          <Legend dot="bg-up/80" label="Idle — free for withdrawals" value={<Money value={idle} />} />
          <Legend dot="bg-white/25" label="Backing open markets" value={<Money value={deployed} />} />
        </div>

        {(reserve > 0 || feeInc > 0) && (
          <p className="font-mono text-[10px] tabular-nums text-text-3">
            Protocol-owned, outside the pool: reserve {fmtQuote(reserve)} · fee incentives {fmtQuote(feeInc)}
          </p>
        )}

        {/* last keeper flush — when the queue actually filled / pool was re-valued */}
        <div className="hairline-fade" />
        <p className="text-[11px] leading-relaxed text-text-3">
          {flush ? (
            <>
              Last vault update {ago(flush.checkpoint_timestamp_ms, now)} — {flush.market_count}{' '}
              markets valued
              {flush.requests_processed > 0
                ? `, ${flush.supplies_filled} deposits and ${flush.withdrawals_filled} withdrawals filled.`
                : '.'}
            </>
          ) : (
            'Waiting for the next vault update…'
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * A DUSDC / share amount that fits tight mobile cards: full precision on ≥sm
 * (desktop has the room), compact (9.91M / 11.09K) below that. A pure CSS swap,
 * so it's SSR-safe (no hydration flip on mount).
 */
function Money({ value }: { value: number }) {
  return (
    <>
      <span className="sm:hidden">{compact(value)}</span>
      <span className="hidden sm:inline">{fmtQuote(value)}</span>
    </>
  );
}

function SmallStat({
  icon,
  color,
  label,
  value,
  sub,
  info,
}: {
  icon: IconType;
  color: string;
  label: string;
  value: React.ReactNode;
  sub: string;
  info?: React.ReactNode;
}) {
  return (
    <div className="glass-inset flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <IconChip icon={icon} color={color} size={22} />
        <span className="eyebrow">{label}</span>
        {info && <InfoTip label={label}>{info}</InfoTip>}
      </div>
      <span className="flex items-baseline gap-1.5">
        <span className="text-[20px] leading-none tracking-tight text-text-1">{value}</span>
      </span>
      <span className="text-[10px] uppercase tracking-[0.12em] text-text-3">{sub}</span>
    </div>
  );
}

function Legend({ dot, label, value }: { dot: string; label: string; value: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {label} <span className="text-text-2">{value}</span>
    </span>
  );
}
