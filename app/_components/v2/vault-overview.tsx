'use client';

/**
 * V2VaultOverview — the read side of the vault (legacy vault/risk role): real
 * on-chain metrics, a liquidity-composition meter, queue status, and the trader's
 * own shares. Deliberately shows only honest, directly-readable figures — v2 has
 * no read-only NAV / utilization / share-price view (those settle at the keeper
 * flush), so no fabricated gauges. Glass; plain copy.
 */
import { useVaultV2 } from '@/lib/hooks/use-vault-v2';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { fromQuote } from '@/config/scale';

export function V2VaultOverview() {
  const { vault } = useVaultV2();
  const acct = usePredictAccountV2();

  const idle = vault ? fromQuote(vault.idleBalance) : 0;
  const reserve = vault ? fromQuote(vault.protocolReserve) : 0;
  const feeInc = vault ? fromQuote(vault.feeIncentiveReserve) : 0;
  const total = idle + reserve + feeInc;
  const yourShares = fromQuote(acct.plpBalanceBase);

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
        <Stat label="Total liquidity" value={vault ? `$${fmt(idle)}` : '—'} sub="idle DUSDC" />
        <Stat label="Total shares" value={vault ? fmt(fromQuote(vault.plpTotalSupply)) : '—'} sub="PLP" />
        <Stat label="Your shares" value={acct.wrapperExists ? fmt(yourShares) : '—'} sub="PLP" />
        <Stat
          label="In the queue"
          value={vault ? `${vault.supplyPending} / ${vault.withdrawPending}` : '—'}
          sub="deposits / withdrawals"
        />
      </div>

      {/* liquidity composition — real proportions of the vault's DUSDC holdings */}
      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="eyebrow">Liquidity composition</span>
          <span className="font-mono text-[11px] text-text-3">${fmt(total)}</span>
        </div>
        <div className="flex h-2 overflow-hidden rounded-full bg-white/5">
          <Seg value={idle} total={total} className="bg-[var(--accent)]" />
          <Seg value={reserve} total={total} className="bg-text-3" />
          <Seg value={feeInc} total={total} className="bg-text-3/50" />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-text-3">
          <Legend dot="bg-[var(--accent)]" label="Idle" value={`$${fmt(idle)}`} />
          <Legend dot="bg-text-3" label="Protocol reserve" value={`$${fmt(reserve)}`} />
          <Legend dot="bg-text-3/50" label="Fee incentives" value={`$${fmt(feeInc)}`} />
        </div>
      </div>
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
