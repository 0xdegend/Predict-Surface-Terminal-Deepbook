import { getOracles, getOracleState } from '@/lib/api/client';
import { toFloat } from '@/config/scale';
import { parseSvi } from '@/lib/svi/svi';
import type { SmileInput } from '@/lib/svi/surface';
import { TopChrome } from '../_components/top-chrome';
import { HedgePanel } from '../_components/vault/hedge-panel';
import { VaultPositionPanel } from '../_components/vault/vault-position-panel';
import { ErrorState } from '../_components/ui/error-state';

export const dynamic = 'force-dynamic';

export default async function VaultRoute() {
  // eslint-disable-next-line react-hooks/purity
  const serverNow = Date.now();
  let inputs: SmileInput[] = [];
  let error: string | null = null;

  try {
    const oracles = await getOracles();
    const active = oracles.filter((o) => o.status === 'active').sort((a, b) => a.expiry - b.expiry);
    const states = await Promise.all(active.map((o) => getOracleState(o.oracle_id)));
    inputs = states.flatMap((st, i) => {
      if (!st.latest_svi || !st.latest_price) return [];
      return [
        {
          oracle: active[i],
          svi: parseSvi(st.latest_svi),
          forward: toFloat(st.latest_price.forward),
          settlement: active[i].settlement_price != null ? toFloat(active[i].settlement_price!) : null,
        },
      ];
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="flex min-h-screen flex-col">
      <TopChrome active="vault" />
      {error ? (
        <ErrorState
          title="Failed to load markets"
          message={error}
          note="Usually a transient network hiccup — the server is reachable."
        />
      ) : (
        <main className="flex-1">
          <HedgePanel inputs={inputs} serverNow={serverNow} />
          <VaultPositionPanel />
        </main>
      )}
    </div>
  );
}
