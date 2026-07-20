'use client';

/**
 * useVaultActivity — recent EXECUTED LP flows for the vault, from the indexer's
 * `/vaults/:id/{supply-fills,withdraw-fills}` feeds (shipped ~2026-07, verified
 * live 2026-07-19). A deposit fills escrowed DUSDC into PLP shares at the keeper's
 * NAV; a withdrawal burns shares back to DUSDC. Both carry `dusdc_amount`, so the
 * whole ledger is in DUSDC and the net flow is summable.
 *
 * This is the read-side history across ALL LPs — complementary to V2VaultQueue,
 * which shows the connected user's still-PENDING (cancellable) on-chain queue.
 * Server-only, so it renders for any visitor.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getVaultSupplyFills, getVaultWithdrawFills, qkV2 } from '@/lib/api/v2/client';
import { predictV2Config } from '@/config/predict';
import { fromQuote } from '@/config/scale';
import type { V2VaultSupplyFill, V2VaultWithdrawFill } from '@/lib/api/v2/types';

export interface VaultActivityRow {
  key: string;
  side: 'deposit' | 'withdraw';
  accountId: string;
  /** DUSDC moved (into the pool for a deposit, out for a withdrawal). */
  dusdc: number;
  /** PLP shares minted (deposit) or burned (withdraw). */
  shares: number;
  /** Realized NAV for the fill = dusdc / shares (DUSDC per share). */
  pricePerShare: number;
  ts: number;
}

export interface VaultActivity {
  rows: VaultActivityRow[];
  /** DUSDC deposited over the shown window. */
  inflow: number;
  /** DUSDC withdrawn over the shown window. */
  outflow: number;
  /** inflow − outflow (DUSDC, signed). */
  netFlow: number;
  loading: boolean;
}

const n = (v: unknown): number => (v == null ? 0 : Number(v));

/** A stable, UNIQUE key per fill. The tx `digest` is shared across every fill in
 *  one keeper flush, so it must NOT be the key — use `event_digest` (unique per
 *  event), falling back to digest + event index, then the account/request tuple. */
function fillKey(
  f: { event_digest?: string; digest?: string; event_index?: number; request_index?: number; account_id?: string },
  side: string,
): string {
  return (
    f.event_digest ??
    (f.digest != null ? `${f.digest}-${f.event_index ?? ''}` : `${side}-${f.account_id ?? ''}-${f.request_index ?? ''}`)
  );
}

export function useVaultActivity(limit = 12): VaultActivity {
  const vaultId = predictV2Config.shared.poolVault;

  const q = useQuery({
    queryKey: [...qkV2.vaultFills(vaultId)] as const,
    queryFn: async ({ signal }) => {
      const [supply, withdraw] = await Promise.all([
        getVaultSupplyFills(vaultId, 30, { signal }),
        getVaultWithdrawFills(vaultId, 30, { signal }),
      ]);
      return { supply, withdraw };
    },
    enabled: !!vaultId,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  return useMemo<VaultActivity>(() => {
    const supply = q.data?.supply ?? [];
    const withdraw = q.data?.withdraw ?? [];

    const toRow = (f: V2VaultSupplyFill | V2VaultWithdrawFill, side: 'deposit' | 'withdraw'): VaultActivityRow => {
      const dusdc = fromQuote(n(f.dusdc_amount));
      const shares = fromQuote(n(side === 'deposit' ? (f as V2VaultSupplyFill).shares_minted : (f as V2VaultWithdrawFill).shares_burned));
      return {
        key: fillKey(f, side),
        side,
        accountId: String(f.account_id ?? ''),
        dusdc,
        shares,
        pricePerShare: shares > 0 ? dusdc / shares : 0,
        ts: n(f.checkpoint_timestamp_ms),
      };
    };

    const all = [
      ...supply.map((f) => toRow(f, 'deposit')),
      ...withdraw.map((f) => toRow(f, 'withdraw')),
    ].sort((a, b) => b.ts - a.ts);

    const rows = all.slice(0, limit);
    // Net flow is measured over the shown window (the rows on screen), so the
    // headline figure always matches what the LP can see.
    let inflow = 0;
    let outflow = 0;
    for (const r of rows) {
      if (r.side === 'deposit') inflow += r.dusdc;
      else outflow += r.dusdc;
    }

    return { rows, inflow, outflow, netFlow: inflow - outflow, loading: q.isLoading };
  }, [q.data, q.isLoading, limit]);
}
