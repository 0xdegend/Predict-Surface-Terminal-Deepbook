'use client';

/**
 * useSkewFeeRate — the PLANNED Skew fee, a percentage of each bet, charged on top of the
 * live builder fee. It is a planning input, not an on-chain charge yet: the v2 skew-fee
 * router isn't published (config/predict `skewFeePackageId` is empty for v2/mainnet), so
 * this rate only drives the admin earnings projection. When the router ships at mainnet the
 * same rate is what you'd set on-chain (fee_router set_fee_bps). Persisted per-device in
 * localStorage so an admin's chosen rate survives reloads; the projection reads it live.
 *
 * Stored as basis points (100 = 1.00%) to match the on-chain FeeConfig.fee_bps unit.
 */
import { useCallback, useEffect, useState } from 'react';

const KEY = 'skew.admin.skewFeeBps';
/** Default matches the on-chain FeeConfig default the router shipped with (1%). */
export const DEFAULT_SKEW_FEE_BPS = 100;
const MIN_BPS = 0;
/** Sanity ceiling so a fat-fingered entry can't model an absurd 900% fee. */
const MAX_BPS = 1000; // 10%

const clampBps = (n: number): number =>
  Number.isFinite(n) ? Math.max(MIN_BPS, Math.min(MAX_BPS, Math.round(n))) : DEFAULT_SKEW_FEE_BPS;

export function useSkewFeeRate(): {
  /** Rate in basis points (100 = 1.00%). */
  bps: number;
  setBps: (v: number) => void;
  reset: () => void;
} {
  const [bps, setBpsState] = useState(DEFAULT_SKEW_FEE_BPS);

  // Read the saved rate AFTER mount (not in the initializer) so SSR and the first client
  // paint agree on the default — no hydration mismatch.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw != null) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot sync from localStorage
        setBpsState(clampBps(Number(raw)));
      }
    } catch {
      /* private mode / no storage — keep the default */
    }
  }, []);

  const setBps = useCallback((v: number) => {
    const c = clampBps(v);
    setBpsState(c);
    try {
      localStorage.setItem(KEY, String(c));
    } catch {
      /* ignore */
    }
  }, []);

  const reset = useCallback(() => setBps(DEFAULT_SKEW_FEE_BPS), [setBps]);

  return { bps, setBps, reset };
}
