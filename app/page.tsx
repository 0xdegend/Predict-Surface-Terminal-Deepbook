import { getStatus, getPredictState, getOracles, getOracleState } from '@/lib/api/client';
import { predictConfig } from '@/config/predict';
import { toFloat } from '@/config/scale';
import { parseSvi } from '@/lib/svi/svi';
import type { SmileInput } from '@/lib/svi/surface';
import { TopChrome } from './_components/top-chrome';
import { FlowPanel } from './_components/flow-panel';
import { SurfaceMount } from './_components/surface/surface-mount';
import { LiveSviPanel } from './_components/live-svi-panel';
import { MarketPicker } from './_components/market-picker';
import { ErrorState } from './_components/ui/error-state';
import type { Oracle } from '@/lib/api/types';

// Phase 0 verification screen. Server Component: fetches the live snapshot so the
// terminal renders WITH data; the client tape attaches on top for the live feed.
export const dynamic = 'force-dynamic';

export default async function Page() {
  let snapshot:
    | {
        statusOk: boolean;
        checkpointLag: number;
        timeLagS: number;
        tradingPaused: boolean | null;
        quoteAssets: string[];
        oracles: Oracle[];
        first: Awaited<ReturnType<typeof getOracleState>> | null;
        surfaceInputs: SmileInput[];
      }
    | null = null;
  let error: string | null = null;

  try {
    const [status, state, oracles] = await Promise.all([
      getStatus(),
      getPredictState(),
      getOracles(),
    ]);
    // Active oracles, soonest expiry first.
    const active = oracles
      .filter((o) => o.status === 'active')
      .sort((a, b) => a.expiry - b.expiry);

    // Fetch every active oracle's state in parallel to build the surface.
    const states = await Promise.all(active.map((o) => getOracleState(o.oracle_id)));
    const surfaceInputs: SmileInput[] = states.flatMap((st, i) => {
      if (!st.latest_svi || !st.latest_price) return [];
      return [
        {
          oracle: active[i],
          svi: parseSvi(st.latest_svi),
          forward: toFloat(st.latest_price.forward),
          settlement:
            active[i].settlement_price != null ? toFloat(active[i].settlement_price!) : null,
        },
      ];
    });

    snapshot = {
      statusOk: status.status === 'OK',
      checkpointLag: status.max_checkpoint_lag,
      timeLagS: status.max_time_lag_seconds,
      tradingPaused: state.trading_paused,
      quoteAssets: state.quote_assets,
      oracles: active,
      first: states[0] ?? null,
      surfaceInputs,
    };
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // Seed for the live clocks (countdown ticking) — keeps SSR/first-paint stable.
  // This is an async Server Component; a request-time timestamp is intentional.
  // eslint-disable-next-line react-hooks/purity
  const serverNow = Date.now();

  return (
    <div className="flex min-h-screen flex-col">
      <TopChrome
        active="surface"
        tape={
          snapshot?.oracles[0]
            ? {
                oracleId: snapshot.oracles[0].oracle_id,
                underlying: snapshot.oracles[0].underlying_asset,
                initial: snapshot.first?.latest_price ?? null,
              }
            : null
        }
        diagnostics={
          snapshot
            ? {
                statusOk: snapshot.statusOk,
                checkpointLag: snapshot.checkpointLag,
                timeLagS: snapshot.timeLagS,
                tradingPaused: snapshot.tradingPaused,
                quoteSymbol: predictConfig.quote.symbol,
                activeOracles: snapshot.oracles.length,
              }
            : null
        }
      />

      {error ? (
        <ErrorState
          title="Failed to reach Predict server"
          message={error}
          detail={predictConfig.serverUrl}
          note="This is usually a transient local network/DNS hiccup — the server is reachable."
        />
      ) : snapshot ? (
        <>
          <main className="rise grid flex-1 grid-cols-1 gap-px bg-white/[0.06] lg:grid-cols-[1fr_380px]">
            <section className="flex flex-col gap-px bg-white/[0.06]">
              {/* 3-D SVI surface — the hero */}
              <div className="h-[48vh] min-h-[360px] bg-bg-0 lg:h-[64vh] lg:min-h-[520px]">
                <SurfaceMount oracles={snapshot.oracles} initialInputs={snapshot.surfaceInputs} />
              </div>

              {/* Market picker — cards (beginner) or table (dense), both clickable:
                  select on the surface + load the ticket. flex-1 so the panel fills
                  the column (the right rail is taller) instead of leaving an empty band. */}
              <div className="flex-1 bg-bg-0 p-4 sm:p-5">
                <MarketPicker
                  oracles={snapshot.oracles}
                  inputs={snapshot.surfaceInputs}
                  serverNow={serverNow}
                />
              </div>
            </section>

            {/* Right rail: live SVI + the trade flow. Stacks below on mobile. */}
            <aside className="flex flex-col gap-6 bg-bg-0 p-4 sm:p-5">
              <LiveSviPanel
                oracles={snapshot.oracles}
                initialInputs={snapshot.surfaceInputs}
                serverNow={serverNow}
              />

              {snapshot.surfaceInputs.length > 0 && (
                <div id="trade-ticket" className="scroll-mt-20 border-t border-white/[0.08] pt-5">
                  <SectionTitle>Trade ticket · click surface → mint</SectionTitle>
                  <div className="mt-3">
                    <FlowPanel inputs={snapshot.surfaceInputs} serverNow={serverNow} />
                  </div>
                </div>
              )}
            </aside>
          </main>
        </>
      ) : null}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-text-2">
      <span className="h-3 w-px bg-accent/70" />
      {children}
    </h2>
  );
}
