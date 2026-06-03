import { getStatus, getPredictState, getOracles, getOracleState } from '@/lib/api/client';
import { predictConfig } from '@/config/predict';
import { toFloat } from '@/config/scale';
import { parseSvi } from '@/lib/svi/svi';
import type { SmileInput } from '@/lib/svi/surface';
import { TopChrome } from './_components/top-chrome';
import { FlowPanel } from './_components/flow-panel';
import { SurfaceMount } from './_components/surface/surface-mount';
import { LiveSviPanel } from './_components/live-svi-panel';
import { OracleTable } from './_components/oracle-table';
import { RetryButton } from './_components/retry-button';
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
        phase="Phase 4 · click-to-trade"
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
      />

      {error ? (
        <ErrorPanel message={error} />
      ) : snapshot ? (
        <>
          {/* Status strip */}
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2 border-b border-white/[0.08] px-5 py-2.5">
            <Stat
              label="SERVER"
              value={snapshot.statusOk ? 'OK' : 'DEGRADED'}
              tone={snapshot.statusOk ? 'good' : 'bad'}
            />
            <Stat label="CKPT LAG" value={`${snapshot.checkpointLag}`} />
            <Stat label="TIME LAG" value={`${snapshot.timeLagS}s`} />
            <Stat
              label="TRADING"
              value={snapshot.tradingPaused ? 'PAUSED' : 'LIVE'}
              tone={snapshot.tradingPaused ? 'bad' : 'good'}
            />
            <Stat label="QUOTE" value={predictConfig.quote.symbol} />
            <Stat label="ACTIVE ORACLES" value={`${snapshot.oracles.length}`} />
          </div>

          <main className="grid flex-1 grid-cols-1 gap-px bg-white/[0.06] lg:grid-cols-[1fr_380px]">
            <section className="flex flex-col gap-px bg-white/[0.06]">
              {/* 3-D SVI surface — the hero */}
              <div className="h-[56vh] min-h-[420px] bg-[#0A0B0D]">
                <SurfaceMount oracles={snapshot.oracles} initialInputs={snapshot.surfaceInputs} />
              </div>

              {/* Oracle grid — clickable: selects on the surface + loads ticket.
                  flex-1 so the panel fills the column (the right rail is taller),
                  instead of leaving an empty band under the rows. */}
              <div className="flex-1 bg-[#0A0B0D] p-5">
                <OracleTable
                  oracles={snapshot.oracles}
                  inputs={snapshot.surfaceInputs}
                  serverNow={serverNow}
                />
              </div>
            </section>

            {/* Right rail: live SVI + the Phase 1 flow */}
            <aside className="flex flex-col gap-6 bg-[#0A0B0D] p-5">
              <LiveSviPanel
                oracles={snapshot.oracles}
                initialInputs={snapshot.surfaceInputs}
                serverNow={serverNow}
              />

              {snapshot.surfaceInputs.length > 0 && (
                <div id="trade-ticket" className="hidden border-t border-white/[0.08] pt-5 lg:block">
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

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="m-5 rounded border border-red-500/30 bg-red-500/[0.06] p-4">
      <p className="text-[12px] font-medium text-red-300">Failed to reach Predict server</p>
      <p className="mt-1 font-mono text-[11px] text-[#8B9099]">{message}</p>
      <p className="mt-2 text-[11px] text-[#5A5F66]">{predictConfig.serverUrl}</p>
      <p className="mt-2 text-[11px] text-[#5A5F66]">
        This is usually a transient local network/DNS hiccup — the server is reachable.
      </p>
      <RetryButton />
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'bad';
}) {
  const color =
    tone === 'good' ? 'text-teal-400' : tone === 'bad' ? 'text-red-400' : 'text-[#E6E8EB]';
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] uppercase tracking-wider text-[#5A5F66]">{label}</span>
      <span className={`font-mono text-[12px] tabular-nums ${color}`}>{value}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-[#8B9099]">
      <span className="h-3 w-px bg-up/60" />
      {children}
    </h2>
  );
}
