'use client';

/**
 * Live + time-travel data for the surface.
 *
 *  - LIVE: poll every active oracle's state (~2s) → current SmileInput[].
 *  - SCRUB: fetch each oracle's SVI + price history once, then reconstruct the
 *    whole surface at any past timestamp via `snapshotAt` (per-oracle: latest
 *    snapshot at-or-before the scrub time).
 *
 * Real event subscription scores better (§4) but server polling at ~2s is the
 * robust path for the live demo; the indexer is ~1s fresh. Stress perturbation
 * (no-arb demo) is applied here so it composes with both live and scrub.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getOracleState, getSviHistory, getPriceHistory } from '@/lib/api/client';
import { toFloat } from '@/config/scale';
import { parseSvi } from '@/lib/svi/svi';
import { stressSvi, type SmileInput } from '@/lib/svi/surface';
import { useSurfaceStore } from '@/lib/store/surface-store';
import type { Oracle, SviEvent, PriceEvent } from '@/lib/api/types';

const SVI_LIMIT = 80;
const PRICE_LIMIT = 150;

function settlementFloat(o: Oracle): number | null {
  return o.settlement_price != null ? toFloat(o.settlement_price) : null;
}

interface OracleHistory {
  oracle: Oracle;
  svi: SviEvent[]; // ascending by onchain_timestamp
  prices: PriceEvent[]; // ascending
}

function latestAtOrBefore<T extends { onchain_timestamp: number }>(arr: T[], t: number): T | null {
  if (arr.length === 0) return null;
  let lo = arr[0];
  for (const item of arr) {
    if (item.onchain_timestamp <= t) lo = item;
    else break;
  }
  return lo;
}

function snapshotAt(per: OracleHistory[], t: number): SmileInput[] {
  return per.flatMap((h) => {
    const svi = latestAtOrBefore(h.svi, t) ?? h.svi[0];
    const price = latestAtOrBefore(h.prices, t) ?? h.prices[0];
    if (!svi || !price) return [];
    return [
      {
        oracle: h.oracle,
        svi: parseSvi(svi),
        forward: toFloat(price.forward),
        settlement: settlementFloat(h.oracle),
      },
    ];
  });
}

export interface SurfaceData {
  inputs: SmileInput[];
  isLive: boolean;
  /** History window bounds (ms), null until history loads. */
  timeline: { tMin: number; tMax: number } | null;
  /** Timestamp currently displayed. */
  currentTime: number;
  historyReady: boolean;
}

export function useSurfaceInputs(oracles: Oracle[], initialInputs: SmileInput[]): SurfaceData {
  const mode = useSurfaceStore((s) => s.mode);
  const scrub = useSurfaceStore((s) => s.scrub);
  const stress = useSurfaceStore((s) => s.stress);

  const oracleIds = oracles.map((o) => o.oracle_id).join(',');

  const liveQ = useQuery({
    queryKey: ['surface', 'live', oracleIds],
    queryFn: async (): Promise<SmileInput[]> => {
      const states = await Promise.all(oracles.map((o) => getOracleState(o.oracle_id)));
      return states.flatMap((st, i) => {
        if (!st.latest_svi || !st.latest_price) return [];
        return [
          {
            oracle: oracles[i],
            svi: parseSvi(st.latest_svi),
            forward: toFloat(st.latest_price.forward),
            settlement: settlementFloat(oracles[i]),
          },
        ];
      });
    },
    initialData: initialInputs,
    refetchInterval: mode === 'live' ? 2000 : false,
  });

  const histQ = useQuery({
    queryKey: ['surface', 'history', oracleIds],
    queryFn: async () => {
      const per: OracleHistory[] = await Promise.all(
        oracles.map(async (o) => {
          const [svi, prices] = await Promise.all([
            getSviHistory(o.oracle_id, SVI_LIMIT),
            getPriceHistory(o.oracle_id, PRICE_LIMIT),
          ]);
          const asc = <T extends { onchain_timestamp: number }>(a: T[]) =>
            [...a].sort((x, y) => x.onchain_timestamp - y.onchain_timestamp);
          return { oracle: o, svi: asc(svi), prices: asc(prices) };
        }),
      );
      let tMin = Infinity;
      let tMax = -Infinity;
      for (const h of per) {
        for (const s of h.svi) {
          if (s.onchain_timestamp < tMin) tMin = s.onchain_timestamp;
          if (s.onchain_timestamp > tMax) tMax = s.onchain_timestamp;
        }
        for (const p of h.prices) {
          if (p.onchain_timestamp < tMin) tMin = p.onchain_timestamp;
          if (p.onchain_timestamp > tMax) tMax = p.onchain_timestamp;
        }
      }
      return { per, tMin: Number.isFinite(tMin) ? tMin : 0, tMax: Number.isFinite(tMax) ? tMax : 0 };
    },
    refetchInterval: 20_000,
    staleTime: 10_000,
  });

  const timeline = histQ.data ? { tMin: histQ.data.tMin, tMax: histQ.data.tMax } : null;

  return useMemo(() => {
    let base: SmileInput[];
    // `currentTime` is only displayed in scrub mode (controls show "now" when
    // live), so we derive it from history bounds — no impure Date.now in render.
    let currentTime = histQ.data?.tMax ?? 0;

    if (mode === 'scrub' && histQ.data && histQ.data.tMax > histQ.data.tMin) {
      const t = histQ.data.tMin + (histQ.data.tMax - histQ.data.tMin) * scrub;
      currentTime = t;
      base = snapshotAt(histQ.data.per, t);
    } else {
      base = liveQ.data ?? initialInputs;
    }

    if (stress > 0) {
      base = base.map((i) => ({ ...i, svi: stressSvi(i.svi, stress) }));
    }

    return {
      inputs: base,
      isLive: mode === 'live',
      timeline,
      currentTime,
      historyReady: !!histQ.data,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, scrub, stress, liveQ.data, histQ.data, initialInputs]);
}
