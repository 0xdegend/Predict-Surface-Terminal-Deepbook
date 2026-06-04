import {
  getVaultSummary,
  getVaultPerformance,
  getOracles,
  getOracleState,
  getPositionsMinted,
  getPositionsRedeemed,
} from '@/lib/api/client';
import { toFloat } from '@/config/scale';
import { parseSvi } from '@/lib/svi/svi';
import { reconstructOpenInterest, type OpenInterest } from '@/lib/risk/whatif';
import type { SmileInput } from '@/lib/svi/surface';
import type { VaultSummary, VaultPerformancePoint } from '@/lib/api/types';
import { TopChrome } from '../_components/top-chrome';
import { RiskPanel } from '../_components/risk/risk-panel';
import { ErrorState } from '../_components/ui/error-state';

export const dynamic = 'force-dynamic';

interface RiskData {
  summary: VaultSummary;
  performance: VaultPerformancePoint[];
  inputs: SmileInput[];
  oi: OpenInterest[];
}

export default async function RiskRoute() {
  let data: RiskData | null = null;
  let error: string | null = null;

  try {
    const [summary, perf, oracles, minted, redeemed] = await Promise.all([
      getVaultSummary(),
      getVaultPerformance('ALL'),
      getOracles(),
      getPositionsMinted(500),
      getPositionsRedeemed(500),
    ]);

    const active = oracles
      .filter((o) => o.status === 'active')
      .sort((a, b) => a.expiry - b.expiry);
    const states = await Promise.all(active.map((o) => getOracleState(o.oracle_id)));
    const inputs: SmileInput[] = states.flatMap((st, i) => {
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

    const activeIds = new Set(active.map((o) => o.oracle_id));
    data = {
      summary,
      performance: perf.points,
      inputs,
      oi: reconstructOpenInterest(minted, redeemed, activeIds),
    };
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="flex min-h-screen flex-col">
      <TopChrome active="risk" />
      {error ? (
        <ErrorState
          title="Failed to load vault data"
          message={error}
          note="Usually a transient local network/DNS hiccup — the server is reachable."
        />
      ) : data ? (
        <main className="flex-1">
          <RiskPanel
            summary={data.summary}
            performance={data.performance}
            inputs={data.inputs}
            oi={data.oi}
          />
        </main>
      ) : null}
    </div>
  );
}
