'use client';

/**
 * TraderName — shows a wallet's SuiNS name (e.g. `alice.sui`) when it has one,
 * else the truncated address. Drop-in replacement for `{shortId(owner)}`; the
 * surrounding link keeps `title={owner}` so the full address is still on hover.
 */
import { shortId } from '@/lib/format';
import { useSuinsName } from '@/lib/hooks/use-suins-name';

export function TraderName({ owner }: { owner: string }) {
  const name = useSuinsName(owner);
  return <>{name ?? shortId(owner)}</>;
}
