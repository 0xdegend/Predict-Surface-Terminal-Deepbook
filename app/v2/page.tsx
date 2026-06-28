/**
 * /v2 — read-only verification screen for the NEW (Latest) deployment.
 *
 * Phase-1 proof-of-life: reads the beta indexer + propbook spot, discovers live
 * ExpiryMarkets grouped by cadence, and for the nearest market in each cadence
 * simulates `load_live_pricer` on-chain and renders the decoded forward + a fair
 * UP/DN strike strip. No wallet, no trading — just proof the v2 read/quote spine
 * works end to end. This route is reachable directly (not via the toggle) while
 * V2 is still "Soon". Styling follows the terminal's glass system.
 */
import { getV2Markets, getV2Status, getPropbookStatus, getPythLatest, pythSpot } from '@/lib/api/v2/client';
import { activeMarkets, groupByCadence, strikeGrid, maxLeverageX, wallClockMs, cadenceOf, CADENCE_ORDER, CADENCE_LABEL, type V2Cadence } from '@/lib/markets/v2-discovery';
import { simulateLivePricer, v2GrpcClient, fairUp, type LivePricer } from '@/lib/sui/v2/pricer';
import { V2TradeTicket, type V2TicketMarket } from '@/app/_components/v2/trade-ticket';
import { V2SpotTape } from '@/app/_components/v2/spot-tape';
import { V2Smile } from '@/app/_components/v2/smile';
import { predictV2Config } from '@/config/predict';
import type { V2Market } from '@/lib/api/v2/types';

export const dynamic = 'force-dynamic';

function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export default async function V2Page() {
  const [marketsRes, statusRes, propStatusRes, pythRes] = await Promise.allSettled([
    getV2Markets(100),
    getV2Status(),
    getPropbookStatus(),
    getPythLatest(predictV2Config.asset.pythFeedId),
  ]);

  const markets = marketsRes.status === 'fulfilled' ? marketsRes.value : [];
  const status = statusRes.status === 'fulfilled' ? statusRes.value : null;
  const propStatus = propStatusRes.status === 'fulfilled' ? propStatusRes.value : null;
  const spot = pythRes.status === 'fulfilled' ? pythSpot(pythRes.value) : null;

  // Use the indexer's request-time clock (aligns with on-chain expiries); wall
  // clock only as a last resort if both indexers are down.
  const now = status?.current_time_ms ?? propStatus?.current_time_ms ?? wallClockMs();
  const active = activeMarkets(markets, now);
  const grouped = groupByCadence(active);

  // Simulate the nearest market in each cadence (3 reads, bounded).
  const targets = CADENCE_ORDER.map((c) => grouped[c][0]).filter(Boolean) as V2Market[];
  const client = v2GrpcClient();
  const priced = await Promise.allSettled(targets.map((m) => simulateLivePricer(client, m.expiry_market_id)));
  const pricerById = new Map<string, LivePricer>();
  targets.forEach((m, i) => {
    const r = priced[i];
    if (r.status === 'fulfilled') pricerById.set(m.expiry_market_id, r.value);
  });

  // Serializable market+pricer snapshot for the client trade ticket.
  const ticketMarkets: V2TicketMarket[] = targets
    .map((m): V2TicketMarket | null => {
      const p = pricerById.get(m.expiry_market_id);
      if (!p) return null;
      return {
        marketId: m.expiry_market_id,
        cadenceLabel: CADENCE_LABEL[cadenceOf(m)],
        expiry: m.expiry,
        forward: p.forward,
        svi: p.svi,
        tickSize: m.tick_size,
        admissionTickSize: m.admission_tick_size,
        maxEntryProbability: m.max_entry_probability,
        maxLeverage: maxLeverageX(m),
        baseFee: m.base_fee,
      };
    })
    .filter((m): m is V2TicketMarket => m !== null);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <p className="eyebrow mb-1">Latest deployment · preview</p>
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-[22px] font-semibold tracking-tight text-text-1">v2 read &amp; quote spine</h1>
          <a href="/v2/vault" className="shrink-0 rounded-md bg-white/5 px-3 py-1.5 text-[12px] text-text-2 transition-colors hover:text-text-1">
            Liquidity vault →
          </a>
        </div>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-text-2">
          Live, read-only proof that the new Predict release is wired up: markets discovered
          from the beta indexer, spot from the oracle indexer, and a fair price computed from an
          on-chain pricing snapshot — no wallet needed.
        </p>
      </header>

      <div className="mb-4">
        <V2SpotTape />
      </div>

      {/* Health strip */}
      <section className="panel mb-6 grid grid-cols-2 gap-px overflow-hidden sm:grid-cols-4">
        <Stat label="BTC spot" value={spot != null ? `$${spot.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'} />
        <Stat label="Active markets" value={String(active.length)} />
        <Stat label="Beta indexer" value={status ? status.status : 'down'} ok={!!status} />
        <Stat label="Oracle indexer" value={propStatus ? propStatus.status : 'down'} ok={!!propStatus} />
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div>
          {CADENCE_ORDER.map((c) => (
            <CadenceSection
              key={c}
              cadence={c}
              markets={grouped[c]}
              target={grouped[c][0]}
              pricer={grouped[c][0] ? pricerById.get(grouped[c][0].expiry_market_id) : undefined}
              now={now}
            />
          ))}
        </div>
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <V2TradeTicket markets={ticketMarkets} seedNow={now} />
        </aside>
      </div>
    </main>
  );
}

function Stat({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="bg-bg-1 px-4 py-3">
      <div className="eyebrow mb-1">{label}</div>
      <div className={`font-mono text-[15px] tabular-nums ${ok === false ? 'text-down' : 'text-text-1'}`}>{value}</div>
    </div>
  );
}

function CadenceSection({
  cadence,
  markets,
  target,
  pricer,
  now,
}: {
  cadence: V2Cadence;
  markets: V2Market[];
  target?: V2Market;
  pricer?: LivePricer;
  now: number;
}) {
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-[14px] font-medium tracking-tight text-text-1">
          {CADENCE_LABEL[cadence]} markets
        </h2>
        <span className="font-mono text-[11px] text-text-3">{markets.length} live</span>
      </div>

      {!target ? (
        <div className="card px-4 py-6 text-[12px] text-text-3">No live markets in this cadence right now.</div>
      ) : (
        <div className="card p-4">
          <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1">
            <Field label="Expiry" value={`in ${fmtCountdown(target.expiry - now)}`} />
            <Field label="Forward" value={pricer ? `$${pricer.forward.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'} />
            <Field label="Max leverage" value={`${maxLeverageX(target)}x`} />
            <Field label="Market" value={`${target.expiry_market_id.slice(0, 10)}…`} mono />
          </div>

          {pricer ? (
            <>
              <V2Smile forward={pricer.forward} svi={pricer.svi} admissionTickScaled={target.admission_tick_size} />
              <FairStrip pricer={pricer} market={target} />
            </>
          ) : (
            <p className="text-[12px] text-warn">
              Pricer unavailable (feeds may be momentarily stale for this expiry).
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <span className="eyebrow mr-2">{label}</span>
      <span className={`text-[13px] text-text-1 ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function FairStrip({ pricer, market }: { pricer: LivePricer; market: V2Market }) {
  const strikes = strikeGrid(pricer.forward, market.admission_tick_size, 4);
  const atm = Math.round(pricer.forward / (Number(market.admission_tick_size) / 1e9)) * (Number(market.admission_tick_size) / 1e9);
  return (
    <div className="overflow-hidden rounded-md">
      <table className="w-full text-right font-mono text-[12px] tabular-nums">
        <thead>
          <tr className="text-text-3 [&>th]:px-3 [&>th]:pb-1.5 [&>th]:font-normal">
            <th className="text-left">Strike</th>
            <th>Fair UP</th>
            <th>Fair DN</th>
          </tr>
        </thead>
        <tbody className="rows-divided">
          {strikes.map((k) => {
            const up = fairUp(pricer, k);
            const isAtm = Math.abs(k - atm) < 1e-6;
            return (
              <tr key={k} className={`[&>td]:px-3 [&>td]:py-1.5 ${isAtm ? 'bg-(--accent-soft)' : ''}`}>
                <td className="text-left text-text-2">${k.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                <td className="text-up">{(up * 100).toFixed(2)}%</td>
                <td className="text-down">{((1 - up) * 100).toFixed(2)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
