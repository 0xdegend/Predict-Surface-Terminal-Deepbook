"use client";

/**
 * PLP risk panel (§8.4) — answers "is PLP safe?".
 * Vault summary + utilization/headroom gauges + share-price history + the ±Nσ
 * what-if simulator (real net open interest repriced off the live SVI surface).
 * Glassmorphism shell, matching the portfolio / leaderboard surfaces.
 */
import { useMemo, useState } from "react";
import type { IconType } from "react-icons";
import {
  LuShieldCheck,
  LuVault,
  LuGauge,
  LuTrendingUp,
  LuSlidersHorizontal,
  LuTriangleAlert,
  LuArrowDownToLine,
  LuArrowUpFromLine,
  LuArrowLeftRight,
  LuChevronLeft,
  LuChevronRight,
} from "react-icons/lu";
import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react";
import { useQuery } from "@tanstack/react-query";
import { fromQuote } from "@/config/scale";
import {
  quote as fmtQuote,
  pct,
  num,
  signed,
  dateUTC,
  shortId,
} from "@/lib/format";
import { readPredictConfig } from "@/lib/sui/config";
import { qk } from "@/lib/api/client";
import { predictConfig } from "@/config/predict";
import { buildWhatIf, type OpenInterest } from "@/lib/risk/whatif";
import type { VaultFlow } from "@/lib/risk/flows";
import { HUE, IconChip } from "../ui/metric";
import { InfoTip } from "../ui/info-tip";
import type { SmileInput } from "@/lib/svi/surface";
import type { VaultSummary, VaultPerformancePoint } from "@/lib/api/types";

const ACCOUNT_EXPLORER = (addr: string) =>
  `https://suiscan.xyz/${predictConfig.network}/account/${addr}`;

const FALLBACK_SENDER =
  "0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d";

export function RiskPanel({
  summary,
  performance,
  inputs,
  oi,
  flows,
}: {
  summary: VaultSummary;
  performance: VaultPerformancePoint[];
  inputs: SmileInput[];
  oi: OpenInterest[];
  flows: VaultFlow[];
}) {
  const account = useCurrentAccount();
  const client = useCurrentClient();

  const configQ = useQuery({
    queryKey: qk.predictConfig,
    queryFn: () =>
      readPredictConfig(client.core, account?.address ?? FALLBACK_SENDER),
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
    for (const p of whatif.points)
      if (Math.abs(p.nSigma - nSigma) < Math.abs(best.nSigma - nSigma))
        best = p;
    return best;
  }, [whatif, nSigma]);

  const positions = oi.length;
  const netExposure = oi.reduce((a, e) => a + e.netQty, 0);
  const resilient = whatif.worstPnlPct > -0.01;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-5">
      {/* Header */}
      <div className="mb-5">
        <h1 className="flex items-center gap-2 text-[20px] font-semibold tracking-tight text-text-1">
          <LuShieldCheck size={18} className="text-[var(--accent)]" />
          Vault risk
        </h1>
        <p className="mt-1 text-[12px] text-text-3">
          Is the PLP pool safe? · live vault health and a ±Nσ stress test ·{" "}
          {predictConfig.network}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_400px]">
        {/* Left: vault state */}
        <div className="flex flex-col gap-5">
          {/* Vault snapshot bento */}
          <div className="glass-card p-5">
            <div className="flex items-center gap-2.5">
              <IconChip icon={LuVault} color={HUE.teal} size={30} />
              <span className="eyebrow">Vault value</span>
            </div>
            <div className="mt-2.5 flex items-baseline gap-2 font-mono tabular-nums">
              <span className="text-[34px] leading-none tracking-tight text-text-1">
                {fmtQuote(fromQuote(summary.vault_value))}
              </span>
              <span className="text-[11px] text-text-3">
                {predictConfig.quote.symbol}
              </span>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <Inset
                label="PLP share price"
                value={num(summary.plp_share_price, 6)}
                strong
              />
              <Inset
                label="Liability (MTM)"
                value={fmtQuote(fromQuote(summary.total_mtm))}
              />
              <Inset
                label="Max payout"
                value={fmtQuote(fromQuote(summary.total_max_payout))}
              />
              <Inset
                label="PLP supply"
                value={fmtQuote(fromQuote(summary.plp_total_supply))}
              />
              <Inset
                label="Balance"
                value={fmtQuote(fromQuote(summary.vault_balance))}
              />
              <Inset
                label="Net deposits"
                value={fmtQuote(fromQuote(summary.net_deposits))}
              />
              <Inset
                label="Supplied"
                value={fmtQuote(fromQuote(summary.total_supplied))}
              />
              <Inset
                label="Withdrawn"
                value={fmtQuote(fromQuote(summary.total_withdrawn))}
              />
            </div>
          </div>

          {/* Utilization */}
          <div className="glass-card p-5">
            <CardTitle icon={LuGauge} color={HUE.amber}>
              Utilization
            </CardTitle>
            <div className="mt-4 flex flex-col gap-4">
              <Gauge
                label="Exposure vs cap"
                value={summary.utilization}
                max={maxExposure}
                caption={`${pct(summary.utilization, 3)} of ${pct(maxExposure, 0)} cap`}
              />
              <Gauge
                label="Max-payout utilization"
                value={summary.max_payout_utilization}
                max={1}
                caption={pct(summary.max_payout_utilization, 3)}
              />
              <Gauge
                label="Withdrawal headroom"
                value={
                  1 -
                  summary.available_withdrawal /
                    Math.max(summary.vault_value, 1)
                }
                max={1}
                caption={`${fmtQuote(fromQuote(summary.available_withdrawal))} available`}
                invert
              />
            </div>
          </div>

          {/* Share-price history */}
          <div className="glass-card p-5">
            <CardTitle icon={LuTrendingUp} color={HUE.teal}>
              PLP share price · history
            </CardTitle>
            <div className="glass-inset mt-4 p-3">
              <PerfChart points={performance} />
            </div>
          </div>

          {/* Vault flows — LP capital in / out */}
          <div className="glass-card p-5">
            <CardTitle icon={LuArrowLeftRight} color={HUE.violet}>
              Vault flows
            </CardTitle>
            <FlowsTable flows={flows} />
          </div>
        </div>

        {/* Right: what-if */}
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <div className="glass-card p-5">
            <CardTitle icon={LuSlidersHorizontal} color={HUE.blue}>
              Stress test
            </CardTitle>

            {/* Verdict — the headline answer, up top and prominent */}
            <div className="glass-inset relative mt-4 flex items-start gap-3 overflow-hidden p-4">
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  background: `radial-gradient(130% 110% at 0% 0%, color-mix(in srgb, ${resilient ? "var(--up)" : "var(--down)"} 13%, transparent), transparent 62%)`,
                }}
              />
              <IconChip
                icon={resilient ? LuShieldCheck : LuTriangleAlert}
                color={resilient ? HUE.teal : HUE.coral}
                size={40}
              />
              <div className="relative flex min-w-0 flex-col gap-1">
                <span
                  className="text-[14px] font-semibold leading-tight"
                  style={{ color: resilient ? "var(--up)" : "var(--down)" }}
                >
                  {resilient ? "The pool is safe" : "Heads-up: elevated risk"}
                </span>
                <p className="text-[12px] leading-relaxed text-text-2">
                  {resilient
                    ? "Even in a rare, extreme price swing, liquidity providers would lose under 1% of the pool."
                    : `In a rare, extreme price swing the pool could drop about ${pct(Math.abs(whatif.worstPnlPct), 1)}.`}
                </p>
              </div>
            </div>

            <p className="mt-4 text-[12px] leading-relaxed text-text-3">
              Drag the slider to simulate a sudden price move and see how the
              pool would hold up — its live open bets are re-priced in real
              time.
            </p>
            <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-text-3">
              <span className="inline-flex items-center gap-1">
                1σ ≈ {pct(whatif.sigma, 2)} move
                <InfoTip label="standard deviation (sigma)">
                  σ (sigma) measures how big a price move is. 1σ ≈{" "}
                  {pct(whatif.sigma, 2)} is a normal day; ±3σ is a rare, extreme
                  swing — about 99.7% of moves are smaller.
                </InfoTip>
              </span>
              <span>
                · {positions} live strikes, {fmtQuote(fromQuote(netExposure))}{" "}
                {predictConfig.quote.symbol} at risk
              </span>
            </p>

            <div className="glass-inset mt-4 p-2.5">
              <WhatIfCurve whatif={whatif} nSigma={nSigma} />
            </div>

            <input
              type="range"
              min={-3}
              max={3}
              step={0.25}
              value={nSigma}
              onChange={(e) => setNSigma(Number(e.target.value))}
              className="surface-scrub mt-4 h-4 w-full cursor-pointer focus:outline-none focus-visible:outline-none"
              aria-label="Simulated price move, in standard deviations"
            />
            <div className="mt-2 flex items-center justify-between text-[10px] text-text-3">
              <span>↓ Big drop</span>
              <span className="font-mono tabular-nums text-text-1">
                {signed(sel.shockPct * 100, 2)}% move{" "}
                <span className="text-text-3">({signed(nSigma, 2)}σ)</span>
              </span>
              <span>Big rise ↑</span>
            </div>

            <div className="glass-inset mt-4 grid grid-cols-2 gap-x-6 gap-y-3 p-4 font-mono text-[12px] tabular-nums">
              <Stat
                label="Projected share price"
                tip="What one PLP share would be worth after this simulated move."
                value={num(sel.sharePrice, 6)}
                strong
              />
              <Stat
                label="Pool P&L"
                tip="Profit or loss for liquidity providers at this move."
                value={pct(sel.pnlPct, 3)}
                tone={
                  sel.pnlPct < 0 ? "down" : sel.pnlPct > 0 ? "up" : undefined
                }
              />
              <Stat
                label="Vault change"
                tip="Change in the pool's total value at this move."
                value={fmtQuote(fromQuote(sel.deltaValue))}
                tone={sel.deltaValue < 0 ? "down" : "up"}
              />
              <Stat
                label="Worst case"
                tip="The biggest loss across a rare, extreme swing (±3 standard deviations)."
                value={pct(whatif.worstPnlPct, 3)}
                tone={whatif.worstPnlPct < -0.005 ? "down" : undefined}
              />
            </div>

            <p className="mt-3 text-[10px] leading-relaxed text-text-3">
              Modeled live from on-chain open interest (binary markets only) —
              reference liability {fmtQuote(fromQuote(whatif.baseLiability))} vs
              reported {fmtQuote(fromQuote(whatif.reportedMtm))}.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function WhatIfCurve({
  whatif,
  nSigma,
}: {
  whatif: ReturnType<typeof buildWhatIf>;
  nSigma: number;
}) {
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
  const sy = (y: number) =>
    PAD + (1 - (y - yMin) / (yMax - yMin)) * (H - 2 * PAD);

  const line = pts
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${sx(p.nSigma).toFixed(1)},${sy(p.pnlPct).toFixed(1)}`,
    )
    .join(" ");
  const area = `${line} L${sx(3).toFixed(1)},${H - PAD} L${sx(-3).toFixed(1)},${H - PAD} Z`;
  const zeroY = sy(0);
  const selX = sx(nSigma);

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="block">
      <defs>
        <linearGradient id="whatif-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(240,121,107,0.16)" />
          <stop offset="100%" stopColor="rgba(240,121,107,0)" />
        </linearGradient>
      </defs>
      <line
        x1={PAD}
        y1={zeroY}
        x2={W - PAD}
        y2={zeroY}
        stroke="rgba(255,255,255,0.10)"
        strokeDasharray="2 3"
      />
      <line
        x1={sx(0)}
        y1={PAD}
        x2={sx(0)}
        y2={H - PAD}
        stroke="rgba(255,255,255,0.06)"
      />
      <path d={area} fill="url(#whatif-fill)" />
      <path d={line} fill="none" stroke="var(--down)" strokeWidth={1.5} />
      {/* selected-shock marker */}
      <line
        x1={selX}
        y1={PAD}
        x2={selX}
        y2={H - PAD}
        stroke="var(--up)"
        strokeWidth={1}
        opacity={0.6}
      />
      <circle
        cx={selX}
        cy={sy(
          whatif.points.reduce(
            (b, p) =>
              Math.abs(p.nSigma - nSigma) < Math.abs(b.nSigma - nSigma) ? p : b,
            whatif.points[0],
          ).pnlPct,
        )}
        r={2.5}
        fill="var(--up)"
      />
      <text
        x={PAD}
        y={H - 2}
        fill="var(--text-3)"
        fontSize={9}
        fontFamily="monospace"
      >
        PLP P&amp;L vs spot shock
      </text>
    </svg>
  );
}

function PerfChart({ points }: { points: VaultPerformancePoint[] }) {
  const W = 560;
  const H = 90;
  const PAD = 6;
  const [hover, setHover] = useState<number | null>(null);

  if (points.length < 2)
    return <p className="text-[11px] text-text-3">No history.</p>;
  const ys = points.map((p) => p.share_price);
  const xs = points.map((p) => p.timestamp_ms);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const sx = (x: number) =>
    PAD + ((x - xMin) / (xMax - xMin || 1)) * (W - 2 * PAD);
  const sy = (y: number) =>
    PAD + (1 - (y - yMin) / (yMax - yMin || 1)) * (H - 2 * PAD);
  const line = points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${sx(p.timestamp_ms).toFixed(1)},${sy(p.share_price).toFixed(1)}`,
    )
    .join(" ");
  const area = `${line} L${sx(xMax).toFixed(1)},${H - PAD} L${sx(xMin).toFixed(1)},${H - PAD} Z`;

  // Map the pointer's x (viewBox units) to the nearest data point.
  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (
        Math.abs(sx(points[i].timestamp_ms) - vx) <
        Math.abs(sx(points[best].timestamp_ms) - vx)
      )
        best = i;
    }
    setHover(best);
  }

  const hp = hover != null ? points[hover] : null;
  const hx = hp ? sx(hp.timestamp_ms) : 0;
  const hy = hp ? sy(hp.share_price) : 0;
  const first = points[0].share_price;
  const changePct = hp && first > 0 ? (hp.share_price / first - 1) * 100 : 0;

  return (
    <div className="relative">
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        className="block cursor-crosshair touch-none"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="perf-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(77,214,176,0.18)" />
            <stop offset="100%" stopColor="rgba(77,214,176,0)" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#perf-fill)" />
        <path d={line} fill="none" stroke="var(--up)" strokeWidth={1.25} />
        {hp && (
          <>
            <line
              x1={hx}
              y1={PAD}
              x2={hx}
              y2={H - PAD}
              stroke="var(--up)"
              strokeWidth={0.75}
              opacity={0.5}
            />
            <circle cx={hx} cy={hy} r={3.5} fill="var(--up)" opacity={0.2} />
            <circle cx={hx} cy={hy} r={2} fill="var(--up)" />
          </>
        )}
        <text
          x={PAD}
          y={11}
          fill="var(--text-3)"
          fontSize={9}
          fontFamily="monospace"
        >
          {num(yMax, 6)}
        </text>
        <text
          x={PAD}
          y={H - 2}
          fill="var(--text-3)"
          fontSize={9}
          fontFamily="monospace"
        >
          {num(yMin, 6)}
        </text>
      </svg>

      {hp && (
        <div className="pointer-events-none absolute right-1.5 top-1.5 z-10 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-right glass">
          <div className="font-mono text-[13px] leading-none tabular-nums text-text-1">
            {num(hp.share_price, 6)}
          </div>
          <div className="mt-1 flex items-center justify-end gap-1.5 font-mono text-[10px] leading-none tabular-nums">
            <span className={changePct >= 0 ? "text-up" : "text-down"}>
              {signed(changePct, 2)}%
            </span>
            <span className="text-text-3">{dateUTC(hp.timestamp_ms)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

const FLOWS_PAGE_SIZE = 8;

function FlowsTable({ flows }: { flows: VaultFlow[] }) {
  const [page, setPage] = useState(0);

  if (flows.length === 0) {
    return (
      <div className="glass-inset mt-4 px-4 py-8 text-center text-[12px] text-text-3">
        No LP flows yet.
      </div>
    );
  }

  // Clamp in render so a shrinking dataset can't strand us on an empty page.
  const pageCount = Math.max(1, Math.ceil(flows.length / FLOWS_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * FLOWS_PAGE_SIZE;
  const pageRows = flows.slice(start, start + FLOWS_PAGE_SIZE);
  const paginated = flows.length > FLOWS_PAGE_SIZE;

  return (
    <div className="glass-inset mt-4 overflow-hidden">
      {/* Scroll horizontally on narrow screens instead of clipping the right-
          hand columns; the min-width keeps the columns from squeezing. */}
      <div className="scroll-quiet overflow-x-auto">
      <table className="w-full min-w-[30rem] border-collapse font-mono text-[12px] tabular-nums">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-text-3 [&>th]:border-b [&>th]:border-line [&>th]:px-3 [&>th]:py-2.5 [&>th]:font-normal">
            <th>Time</th>
            <th>Flow</th>
            <th>LP account</th>
            <th className="text-right">Amount</th>
            <th className="text-right">PLP</th>
          </tr>
        </thead>
        <tbody className="row-divider">
          {pageRows.map((f) => {
            const inflow = f.kind === "in";
            const tone = inflow ? "var(--up)" : "var(--down)";
            return (
              <tr
                key={`${f.digest}-${f.account}-${f.ts}`}
                className="transition-colors hover:bg-white/[0.02] [&>td]:px-3 [&>td]:py-2.5"
              >
                <td className="whitespace-nowrap text-text-3">
                  {dateUTC(f.ts)}
                </td>
                <td>
                  <span
                    className="inline-flex items-center gap-1.5"
                    style={{ color: tone }}
                  >
                    {inflow ? (
                      <LuArrowDownToLine size={12} />
                    ) : (
                      <LuArrowUpFromLine size={12} />
                    )}
                    {inflow ? "Supply" : "Withdraw"}
                  </span>
                </td>
                <td>
                  <a
                    href={ACCOUNT_EXPLORER(f.account)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-text-2 hover:text-[var(--accent)] hover:underline"
                    title={f.account}
                  >
                    {shortId(f.account)}
                  </a>
                </td>
                <td
                  className="whitespace-nowrap text-right"
                  style={{ color: tone }}
                >
                  {inflow ? "+" : "−"}
                  {fmtQuote(fromQuote(f.amount))}
                </td>
                <td className="text-right text-text-2">
                  {num(fromQuote(f.shares), 0)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>

      {paginated && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-3.5 py-2.5">
          <span className="font-mono text-[11px] tabular-nums text-text-3">
            {start + 1}–{start + pageRows.length}{" "}
            <span className="text-text-2">of {flows.length}</span> flows
          </span>
          <div className="flex items-center gap-1">
            <FlowsPagerArrow
              dir="prev"
              disabled={safePage === 0}
              onClick={() => setPage(safePage - 1)}
            />
            <span className="px-1 font-mono text-[11px] tabular-nums text-text-2">
              {safePage + 1} / {pageCount}
            </span>
            <FlowsPagerArrow
              dir="next"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage(safePage + 1)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function FlowsPagerArrow({
  dir,
  disabled,
  onClick,
}: {
  dir: "prev" | "next";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === "prev" ? "Previous page" : "Next page"}
      className="ctrl-soft inline-flex h-7 w-7 items-center justify-center rounded-md text-text-2 disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {dir === "prev" ? (
        <LuChevronLeft size={14} />
      ) : (
        <LuChevronRight size={14} />
      )}
    </button>
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
  const danger = frac > 0.85;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-3">
          {label}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-text-2">
          {caption}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-out ${danger ? "bg-down" : "bg-up"}`}
          style={{ width: `${Math.max(frac * 100, 1.5)}%` }}
        />
      </div>
    </div>
  );
}

/** Glass-inset stat tile (vault bento). */
function Inset({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="glass-inset flex flex-col gap-1.5 p-3.5">
      <span className="eyebrow">{label}</span>
      <span
        className={`font-mono tabular-nums ${strong ? "text-[15px] text-text-1" : "text-[13px] text-text-2"}`}
      >
        {value}
      </span>
    </div>
  );
}

/** Compact label/value (what-if projection grid), with an optional plain-English tip. */
function Stat({
  label,
  value,
  strong,
  tone,
  tip,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "up" | "down";
  tip?: string;
}) {
  const color =
    tone === "up"
      ? "text-up"
      : tone === "down"
        ? "text-down"
        : strong
          ? "text-text-1"
          : "text-text-2";
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1">
        <span className="text-[10px] uppercase tracking-wider text-text-3">
          {label}
        </span>
        {tip && <InfoTip label={label}>{tip}</InfoTip>}
      </span>
      <span
        className={`font-mono tabular-nums ${strong ? "text-[15px]" : "text-[13px]"} ${color}`}
      >
        {value}
      </span>
    </div>
  );
}

function CardTitle({
  icon,
  color,
  children,
}: {
  icon: IconType;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <h2 className="flex items-center gap-2.5">
      <IconChip icon={icon} color={color} size={24} />
      <span className="text-[11px] font-medium uppercase tracking-wider text-text-2">
        {children}
      </span>
    </h2>
  );
}
