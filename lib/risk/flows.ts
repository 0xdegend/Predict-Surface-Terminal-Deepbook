/**
 * lib/risk/flows.ts — merge the vault's LP capital flows into one tape.
 *
 * Supplies are DUSDC flowing INTO the vault (PLP minted); withdrawals are DUSDC
 * flowing OUT (PLP burned). We fold both event streams into a single time-sorted
 * list for the Vault Risk "flows" table. Amounts/shares stay @6dec base units —
 * de-scale (fromQuote) at render, never here.
 */
import type { LpSupplyEvent, LpWithdrawalEvent } from '@/lib/api/types';

export interface VaultFlow {
  /** 'in' = supply (deposit), 'out' = withdrawal. */
  kind: 'in' | 'out';
  /** Event time (ms epoch). */
  ts: number;
  /** Supplier (in) / withdrawer (out) address. */
  account: string;
  /** DUSDC amount, @6dec base units. */
  amount: number;
  /** PLP shares minted (in) / burned (out), @6dec base units. */
  shares: number;
  /** Transaction digest, for the explorer link. */
  digest: string;
}

/** Fold supplies + withdrawals into one newest-first tape, capped at `limit`. */
export function mergeVaultFlows(
  supplies: LpSupplyEvent[],
  withdrawals: LpWithdrawalEvent[],
  limit = 50,
): VaultFlow[] {
  const flows: VaultFlow[] = [
    ...supplies.map((s): VaultFlow => ({
      kind: 'in',
      ts: s.checkpoint_timestamp_ms,
      account: s.supplier,
      amount: s.amount,
      shares: s.shares_minted,
      digest: s.digest,
    })),
    ...withdrawals.map((w): VaultFlow => ({
      kind: 'out',
      ts: w.checkpoint_timestamp_ms,
      account: w.withdrawer,
      amount: w.amount,
      shares: w.shares_burned,
      digest: w.digest,
    })),
  ];
  flows.sort((a, b) => b.ts - a.ts);
  return flows.slice(0, limit);
}
