'use client';

import { useQuery } from '@tanstack/react-query';
import { getLatestPrices, qk } from '@/lib/api/client';
import { toFloat } from '@/config/scale';
import { price, timeUTC } from '@/lib/format';
import type { PriceEvent } from '@/lib/api/types';

/**
 * Live spot/forward tape — polls /oracles/:id/prices/latest at ~1s.
 * Phase 0 proof that the client can consume live protocol data. In Phase 3 this
 * is replaced/augmented by the real event subscription.
 */
export function LiveTape({
  oracleId,
  underlying,
  initial,
}: {
  oracleId: string;
  underlying: string;
  initial: PriceEvent | null;
}) {
  const { data, isFetching } = useQuery({
    queryKey: qk.latestPrices(oracleId),
    queryFn: ({ signal }) => getLatestPrices(oracleId, { signal }),
    initialData: initial ?? undefined,
    refetchInterval: 1000,
  });

  const spot = data ? toFloat(data.spot) : null;
  const forward = data ? toFloat(data.forward) : null;

  return (
    <div className="flex items-center gap-6 font-mono tabular-nums">
      <Field label={`${underlying} SPOT`} value={spot} live={isFetching} />
      <Field label="FWD" value={forward} live={false} />
      <span className="text-[11px] text-[#5A5F66]">
        {data ? timeUTC(data.onchain_timestamp) : '—'}
      </span>
    </div>
  );
}

function Field({
  label,
  value,
  live,
}: {
  label: string;
  value: number | null;
  live: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] uppercase tracking-wider text-[#5A5F66]">{label}</span>
      <span className="text-sm text-[#E6E8EB]">{value === null ? '—' : price(value)}</span>
      {live && <span className="h-1 w-1 rounded-full bg-teal-400 animate-pulse" />}
    </div>
  );
}
