'use client';

/**
 * V2VaultOverview — the read side of the vault (legacy vault/risk role). Blends
 * two honest sources: on-chain views (idle balance, PLP supply, queue counts,
 * reserves) and the indexer's `/vaults/:id/state` (shipped ~2026-07), which
 * finally exposes the full pool NAV — `pool_value` including capital deployed
 * to open markets — so the share price (pool value / total shares) and the
 * trader's position value are real figures now, not fabrications. Glass; plain
 * copy.
 */
import { useVaultV2 } from '@/lib/hooks/use-vault-v2';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useNow } from '@/lib/hooks/use-now';
import { fromQuote } from '@/config/scale';
import { ago } from '@/lib/format';

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

  const yourShares = fromQuote(acct.plpBalanceBase);
  const yourValue = sharePrice != null ? yourShares * sharePrice : null;

  return (
    <div className="panel flex flex-col gap-5 p-4">
      <div>
        <h3 className="text-[14px] font-medium tracking-tight text-text-1">Vault overview</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-text-2">
          The vault backs every open position and earns the protocol’s trading edge. Provide
          liquidity to share in it — deposits and withdrawals fill at the next vault update.
        </p>
      </div>

      {/* headline metrics */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md">
        <Stat
          label="Pool value"
          value={poolValue != null ? `$${fmt(poolValue)}` : '—'}
          sub="backs all positions"
        />
        <Stat
          label="Share price"
          value={sharePrice != null ? `$${sharePrice.toFixed(4)}` : '—'}
          sub="per PLP"
        />
        <Stat label="Total shares" value={vault ? fmt(fromQuote(vault.plpTotalSupply)) : '—'} sub="PLP" />
        <Stat
          label="Your position"
          value={acct.wrapperExists ? (yourValue != null ? `$${fmt(yourValue)}` : '—') : '—'}
          sub={acct.wrapperExists ? `${fmt(yourShares)} PLP` : 'PLP'}
        />
        <Stat label="Idle liquidity" value={vault || cur ? `$${fmt(idle)}` : '—'} sub="DUSDC on hand" />
        <Stat
          label="In the queue"
          value={vault ? `${vault.supplyPending} / ${vault.withdrawPending}` : '—'}
          sub="deposits / withdrawals"
        />
      </div>

      {/* pool composition — idle DUSDC vs capital deployed to open markets */}
      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="eyebrow">Pool composition</span>
          <span className="font-mono text-[11px] text-text-3">${fmt(poolTotal)}</span>
        </div>
        <div className="flex h-2 overflow-hidden rounded-full bg-white/5">
          <Seg value={idle} total={poolTotal} className="bg-accent" />
          <Seg value={deployed} total={poolTotal} className="bg-text-2" />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-text-3">
          <Legend dot="bg-accent" label="Idle" value={`$${fmt(idle)}`} />
          <Legend dot="bg-text-2" label="Backing open markets" value={`$${fmt(deployed)}`} />
        </div>
        {(reserve > 0 || feeInc > 0) && (
          <p className="mt-2 font-mono text-[10px] text-text-3">
            Protocol-owned, outside the pool: reserve ${fmt(reserve)} · fee incentives ${fmt(feeInc)}
          </p>
        )}
      </div>

      {/* last keeper flush — when the queue actually filled / pool was re-valued */}
      {flush && (
        <p className="text-[11px] leading-relaxed text-text-3">
          Last vault update {ago(flush.checkpoint_timestamp_ms, now)} — {flush.market_count} markets
          valued
          {flush.requests_processed > 0
            ? `, ${flush.supplies_filled} deposits and ${flush.withdrawals_filled} withdrawals filled.`
            : '.'}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-white/2 px-3 py-2.5">
      <div className="eyebrow mb-0.5">{label}</div>
      <div className="font-mono text-[14px] tabular-nums text-text-1">
        {value} <span className="text-[10px] text-text-3">{sub}</span>
      </div>
    </div>
  );
}

function Seg({ value, total, className }: { value: number; total: number; className: string }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  if (pct <= 0) return null;
  return <span className={className} style={{ width: `${pct}%` }} />;
}

function Legend({ dot, label, value }: { dot: string; label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {label} <span className="text-text-2">{value}</span>
    </span>
  );
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
