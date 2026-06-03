'use client';

/**
 * PLP risk panel (§8.4) — answers "is PLP safe?".
 * Vault summary + utilization/headroom gauges + performance + the ±Nσ what-if
 * simulator (real net open interest repriced off the live SVI surface).
 */
import { useMemo, useState } from 'react';
import { useCurrentAccount, useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery } from '@tanstack/react-query';
import { fromQuote } from '@/config/scale';
import { quote as fmtQuote, pct, num, signed } from '@/lib/format';
import { readPredictConfig } from '@/lib/sui/config';
import { qk } from '@/lib/api/client';
import { buildWhatIf, type OpenInterest } from '@/lib/risk/whatif';
import type { SmileInput } from '@/lib/svi/surface';
import type { VaultSummary, VaultPerformancePoint } from '@/lib/api/types';

const FALLBACK_SENDER = '0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d';

export function RiskPanel({
  summary,
  performance,
  inputs,
  oi,
}: {
  summary: VaultSummary;
  performance: VaultPerformancePoint[];
  inputs: SmileInput[];
  oi: OpenInterest[];
}) {
  const account = useCurrentAccount();
  const client = useCurrentClient();

  const configQ = useQuery({
    queryKey: qk.predictConfig,
    queryFn: () => readPredictConfig(client.core, account?.address ?? FALLBACK_SENDER),
    staleTime: 60_000,
  });
  const maxExposure = configQ.data?.maxTotalExposurePct ?? 0.8; // constants default 80%

  const [nSigma, setNSigma] = useState(0);

  const whatif = useMemo(
    () =>
      buildWhatIf({
        oi,
        inputs,
        vaultValue: summary.vault_value,
        totalShares: summary.plp_total_supply,
        reportedMtm: summary.total_mtm,
        maxSigma: 3,
        steps: 49,
      }),
    [oi, inputs, summary],
  );

  // Projected scenario at the selected N (nearest swept point).
  const sel = useMemo(() => {
    let best = whatif.points[0];
    for (const p of whatif.points) if (Math.abs(p.nSigma - nSigma) < Math.abs(best.nSigma - nSigma)) best = p;
    return best;
  }, [whatif, nSigma]);

  const positions = oi.length;
  const netExposure = oi.reduce((a, e) => a + e.netQty, 0);

  return (
    <div className="grid grid-cols-1 gap-px bg-white/[0.06] lg:grid-cols-[1fr_420px]">
      {/* Left: vault state */}
      <section className="flex flex-col gap-6 bg-bg-0 p-5">
        <div>
          <SectionTitle>Vault</SectionTitle>
          <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-2 font-mono text-[12px] tabular-nums sm:grid-cols-3">
            <Stat label="Vault value" value={fmtQuote(fromQuote(summary.vault_value))} strong />
            <Stat label="PLP share price" value={num(summary.plp_share_price, 6)} strong />
            <Stat label="Balance" value={fmtQuote(fromQuote(summary.vault_balance))} />
            <Stat label="Liability (MTM)" value={fmtQuote(fromQuote(summary.total_mtm))} />
            <Stat label="Max payout" value={fmtQuote(fromQuote(summary.total_max_payout))} />
            <Stat label="PLP supply" value={fmtQuote(fromQuote(summary.plp_total_supply))} />
            <Stat label="Net deposits" value={fmtQuote(fromQuote(summary.net_deposits))} />
            <Stat label="Supplied" value={fmtQuote(fromQuote(summary.total_supplied))} />
            <Stat label="Withdrawn" value={fmtQuote(fromQuote(summary.total_withdrawn))} />
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <SectionTitle>Utilization</SectionTitle>
          <Gauge
            label="Exposure vs cap"
            value={summary.utilization}
            max={maxExposure}
            caption={`${pct(summary.utilization, 3)} of ${pct(maxExposure, 0)} cap`}
          />
          <Gauge label="Max-payout utilization" value={summary.max_payout_utilization} max={1} caption={pct(summary.max_payout_utilization, 3)} />
          <Gauge
            label="Withdrawal headroom"
            value={1 - summary.available_withdrawal / Math.max(summary.vault_value, 1)}
            max={1}
            caption={`${fmtQuote(fromQuote(summary.available_withdrawal))} available`}
            invert
          />
        </div>

        <div>
          <SectionTitle>PLP share price · history</SectionTitle>
          <PerfChart points={performance} />
        </div>
      </section>

      {/* Right: what-if */}
      <aside className="flex flex-col gap-4 bg-bg-0 p-5">
        <SectionTitle>±Nσ what-if</SectionTitle>
        <p className="text-[11px] leading-relaxed text-text-3">
          Vault liability repriced off the live SVI surface under a spot shock, using real net open
          interest ({positions} strikes, {fmtQuote(fromQuote(netExposure))} notional) across the
          active oracles. 1σ ≈ {pct(whatif.sigma, 2)} spot move.
        </p>

        <WhatIfCurve whatif={whatif} nSigma={nSigma} />

        <input
          type="range"
          min={-3}
          max={3}
          step={0.25}
          value={nSigma}
          onChange={(e) => setNSigma(Number(e.target.value))}
          className="h-1 w-full cursor-pointer appearance-none rounded-full bg-bg-3 accent-up"
          aria-label="Shock in standard deviations"
        />
        <div className="flex justify-between font-mono text-[10px] tabular-nums text-text-3">
          <span>-3σ</span>
          <span className="text-text-1">{signed(nSigma, 2)}σ · {signed(sel.shockPct * 100, 2)}%</span>
          <span>+3σ</span>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-2 border-t border-line-soft pt-3 font-mono text-[12px] tabular-nums">
          <Stat label="Proj. share price" value={num(sel.sharePrice, 6)} strong />
          <Stat
            label="PLP P&L"
            value={pct(sel.pnlPct, 3)}
            tone={sel.pnlPct < 0 ? 'down' : sel.pnlPct > 0 ? 'up' : undefined}
          />
          <Stat label="ΔVault value" value={fmtQuote(fromQuote(sel.deltaValue))} tone={sel.deltaValue < 0 ? 'down' : 'up'} />
          <Stat label="Worst (±3σ)" value={pct(whatif.worstPnlPct, 3)} tone={whatif.worstPnlPct < -0.005 ? 'down' : undefined} />
        </div>

        <div className="rounded border border-line-soft bg-bg-1 p-2 text-[11px] text-text-2">
          <span className="text-text-3">Verdict: </span>
          {whatif.worstPnlPct > -0.01 ? (
            <span className="text-up">PLP resilient — worst-case drawdown under 1% at ±3σ.</span>
          ) : (
            <span className="text-down">Elevated risk — {pct(whatif.worstPnlPct, 2)} at ±3σ.</span>
          )}
        </div>

        <p className="text-[10px] leading-relaxed text-text-3">
          Modeled liability {fmtQuote(fromQuote(whatif.baseLiability))} vs chain MTM{' '}
          {fmtQuote(fromQuote(whatif.reportedMtm))} (open-interest reconstruction; binaries only).
        </p>
      </aside>
    </div>
  );
}

function WhatIfCurve({ whatif, nSigma }: { whatif: ReturnType<typeof buildWhatIf>; nSigma: number }) {
  const W = 380;
  const H = 130;
  const PAD = 8;
  const pts = whatif.points;
  const ys = pts.map((p) => p.pnlPct);
  let yMin = Math.min(...ys, 0);
  let yMax = Math.max(...ys, 0);
  const span = Math.max(yMax - yMin, 0.001); // floor so a flat (safe) curve reads flat
  yMin -= span * 0.1;
  yMax += span * 0.1;
  const sx = (n: number) => PAD + ((n + 3) / 6) * (W - 2 * PAD);
  const sy = (y: number) => PAD + (1 - (y - yMin) / (yMax - yMin)) * (H - 2 * PAD);

  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.nSigma).toFixed(1)},${sy(p.pnlPct).toFixed(1)}`).join(' ');
  const zeroY = sy(0);
  const selX = sx(nSigma);

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="rounded border border-line-soft bg-bg-1">
      <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY} stroke="rgba(255,255,255,0.10)" strokeDasharray="2 3" />
      <line x1={sx(0)} y1={PAD} x2={sx(0)} y2={H - PAD} stroke="rgba(255,255,255,0.06)" />
      <line x1={selX} y1={PAD} x2={selX} y2={H - PAD} stroke="var(--up)" strokeWidth={1} opacity={0.5} />
      <path d={path} fill="none" stroke="var(--down)" strokeWidth={1.5} />
      <text x={PAD} y={H - 2} fill="var(--text-3)" fontSize={9} fontFamily="monospace">
        PLP P&amp;L vs spot shock
      </text>
    </svg>
  );
}

function PerfChart({ points }: { points: VaultPerformancePoint[] }) {
  const W = 560;
  const H = 90;
  const PAD = 6;
  if (points.length < 2) return <p className="mt-2 text-[11px] text-text-3">No history.</p>;
  const ys = points.map((p) => p.share_price);
  const xs = points.map((p) => p.timestamp_ms);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const sx = (x: number) => PAD + ((x - xMin) / (xMax - xMin || 1)) * (W - 2 * PAD);
  const sy = (y: number) => PAD + (1 - (y - yMin) / (yMax - yMin || 1)) * (H - 2 * PAD);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.timestamp_ms).toFixed(1)},${sy(p.share_price).toFixed(1)}`).join(' ');
  const area = `${line} L${sx(xMax).toFixed(1)},${H - PAD} L${sx(xMin).toFixed(1)},${H - PAD} Z`;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="mt-2 rounded border border-line-soft bg-bg-1">
      <path d={area} fill="rgba(77,214,176,0.08)" />
      <path d={line} fill="none" stroke="var(--up)" strokeWidth={1.25} />
      <text x={PAD} y={11} fill="var(--text-3)" fontSize={9} fontFamily="monospace">
        {num(yMax, 6)}
      </text>
      <text x={PAD} y={H - 2} fill="var(--text-3)" fontSize={9} fontFamily="monospace">
        {num(yMin, 6)}
      </text>
    </svg>
  );
}

function Gauge({
  label,
  value,
  max,
  caption,
  invert,
}: {
  label: string;
  value: number;
  max: number;
  caption: string;
  invert?: boolean;
}) {
  const frac = Math.max(0, Math.min(1, value / (max || 1)));
  const danger = invert ? frac > 0.85 : frac > 0.85;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-3">{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-text-2">{caption}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-3">
        <div
          className={`h-full rounded-full ${danger ? 'bg-down' : 'bg-up'}`}
          style={{ width: `${Math.max(frac * 100, 1.5)}%` }}
        />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: 'up' | 'down';
}) {
  const color = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : strong ? 'text-text-1' : 'text-text-2';
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-text-3">{label}</span>
      <span className={`font-mono tabular-nums ${strong ? 'text-[14px]' : 'text-[12px]'} ${color}`}>{value}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-[11px] font-medium uppercase tracking-wider text-text-2">{children}</h2>;
}
