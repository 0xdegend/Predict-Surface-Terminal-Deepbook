'use client';

/**
 * GreeksScenario — the "Payoff & decay" panel: how the SELECTED bet behaves.
 *
 * The ladder + scanner say whether a strike is priced right; this says what happens
 * next. Two questions, answered from the shared `contractGreeks` + `scenarioCurve`
 * (lib/insights/greeks), so the numbers match the surface exactly:
 *   • "if BTC MOVES" → delta, as a live chance + dollar sensitivity, plus a full
 *     what-if payoff diagram you can scrub across a spot range.
 *   • "if it SITS STILL" → theta / time decay, as the outcome this bet drifts to.
 *
 * The diagram plots two lines over a profit/loss field: the smooth MARK-NOW curve
 * (what the bet is worth if you exit now, holding the smile) and the stepped
 * AT-EXPIRY payoff (the final all-or-nothing outcome). The gap between them is the
 * time value. Every dollar figure is framed per $100 staked, before leverage —
 * honest and leverage-agnostic (the ticket owns the real sizing + knockout math).
 *
 * Reads the same selected strike/side the Probability consensus does, so the whole
 * lower page speaks about one bet at a time.
 */
import { useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { num, signed, pct, timeLeftWords } from '@/lib/format';
import { useNow } from '@/lib/hooks/use-now';
import { contractGreeks, scenarioCurve, repricer, settlesInMoney, defaultSpan, type ContractSpec, type ScenarioPoint } from '@/lib/insights';
import { ProOnly, Term } from './vocab';
import type { SviFloat } from '@/lib/svi/svi';

/** Every dollar figure is per this stake, at 1× — honest + leverage-agnostic. */
const STAKE = 100;
/** Keep the loss zone legible when a longshot's win dwarfs it: cap the chart's
 *  upside at 9× the stake (the win chip still shows the true figure). */
const MAX_CHART_PROFIT = STAKE * 9;

const sUsd = (v: number) => `${v < 0 ? '−' : '+'}$${num(Math.abs(v), 0)}`;

export function GreeksScenario({
  pricer,
  strike,
  isUp,
  expiryMs,
  now,
  onBet,
}: {
  pricer: { forward: number; svi: SviFloat } | null | undefined;
  strike: number | null;
  isUp: boolean;
  expiryMs: number | null;
  now: number;
  onBet: () => void;
}) {
  // Live 1s clock for the countdown only (kept off the heavy recompute below).
  const clock = useNow(0);
  // Scrub state: null = parked at the current forward. Declared before any early
  // return so hook order stays stable across the ready/not-ready flip.
  const [scrub, setScrub] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const forward = pricer?.forward ?? 0;
  const svi = pricer?.svi ?? null;
  const ready = !!pricer && strike != null && expiryMs != null && forward > 0;
  // Coarse clock so theta/scenario don't churn on every 1s price tick.
  const coarseNow = Math.floor(now / 10_000) * 10_000;

  const model = useMemo(() => {
    if (!ready || !svi || strike == null || expiryMs == null) return null;
    const spec: ContractSpec = { kind: 'binary', strike, isUp };
    const g = contractGreeks({ spec, forward, svi, expiryMs, now: coarseNow });
    const fair0 = g.fair;
    // Outside a sane band the payout is a longshot with an unstable denominator —
    // the tiles still read fine, the diagram doesn't, so gate the chart out.
    if (fair0 < 0.02 || fair0 > 0.98) return { tooFar: true as const, fair0 };

    const maxWin = STAKE / fair0;
    const profit = maxWin - STAKE;
    const price = repricer({ spec, svi });

    // Frame the range wide enough to always show the strike (and its expiry step).
    const spanPct = Math.min(0.25, Math.max(defaultSpan(svi), Math.abs(strike / forward - 1) * 1.5 + 0.003));
    const scenario = scenarioCurve({ spec, forward, svi, expiryMs, now: coarseNow }, { spanPct, steps: 96 });

    // "If BTC moves $100" — a forward difference (exact for that move, no unit trap).
    const up100 = price(forward + 100);
    const moveChancePts = (up100 - fair0) * 100;
    const moveUsd = (STAKE * (up100 - fair0)) / fair0;

    // "If it sits still" — the outcome the mark drifts to, holding this price.
    const sitWin = settlesInMoney(spec, forward);
    const sitUsd = sitWin ? profit : -STAKE;
    const thetaUsdHr = (STAKE * g.thetaPerHour) / fair0;

    // Pro tiles. Vega: chance points per +1 implied-vol point, and what that is worth
    // on the mark. Gamma: how much delta itself moves per $100 of spot, quoted in
    // chance points so it sits in the same unit as everything else on the panel.
    // At the money a binary's vega is ~0 by construction (a symmetric bet neither gains
    // nor loses from more movement), so snap the last wisp to zero — "-0.0 pts" reads as
    // a broken number rather than a true one.
    const snapZero = (x: number, eps: number) => (Math.abs(x) < eps ? 0 : x);
    const vegaPts = snapZero(g.vegaPerVolPoint * 100, 0.05);
    const vegaUsd = snapZero((STAKE * g.vegaPerVolPoint) / fair0, 0.5);
    const gammaPts = snapZero(g.gamma * 100 * 100, 0.005);

    return {
      tooFar: false as const,
      spec,
      fair0,
      maxWin,
      profit,
      price,
      scenario,
      greeks: g,
      vegaPts,
      vegaUsd,
      gammaPts,
      moveChancePts,
      moveUsd,
      sitWin,
      sitUsd,
      thetaUsdHr,
      Fmin: scenario[0].forward,
      Fmax: scenario[scenario.length - 1].forward,
    };
  }, [ready, svi, forward, strike, isUp, expiryMs, coarseNow]);

  if (!ready || strike == null || expiryMs == null || !model) return null;

  const timeLeft = timeLeftWords(expiryMs - clock);

  const header = (
    <section>
      <div className="mb-3 mt-1 flex items-center gap-2.5">
        <h2 className="text-[14px] font-semibold text-text-1">Payoff &amp; decay</h2>
        <span className="text-[10.5px] uppercase tracking-wide text-text-3">
          <Term plain="what happens if BTC moves, or just sits there" pro="delta, theta and a full what-if payoff" />
        </span>
        <span className="h-px flex-1 bg-linear-to-r from-line to-transparent" />
      </div>
    </section>
  );

  if (model.tooFar) {
    return (
      <>
        {header}
        <div className="glass rounded-lg p-4 text-[13px] leading-relaxed text-text-3">
          This strike is a longshot (about {model.fair0 < 0.5 ? `${(1 / model.fair0).toFixed(0)}×` : 'near-certain'} payout).
          Pick a level nearer spot for the full payoff view.
        </div>
      </>
    );
  }

  const { fair0, maxWin, profit, price, scenario, greeks, moveChancePts, moveUsd, sitWin, sitUsd, thetaUsdHr, vegaPts, vegaUsd, gammaPts, Fmin, Fmax } = model;
  const tone = isUp ? 'up' : 'down';
  const accent = isUp ? 'var(--up)' : 'var(--down)';

  const scrubF = scrub ?? forward;
  const scrubMark = (STAKE * price(scrubF)) / fair0;
  const scrubPnl = scrubMark - STAKE;
  const scrubWin = settlesInMoney(model.spec, scrubF);
  const scrubMovePct = (scrubF / forward - 1) * 100;

  // Set the scrubber from a pointer over the plot (delightful; the range input
  // below is the accessible/touch path). Linear because the svg stretches its
  // viewBox to the element width (preserveAspectRatio none).
  function scrubFromPointer(clientX: number) {
    const el = svgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    setScrub(Fmin + frac * (Fmax - Fmin));
  }

  return (
    <>
      {header}
      <div className={`glass rounded-lg p-4 ${tone === 'up' ? 'up' : 'down'}`}>
        {/* What bet we're reading, + one-click place. */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="font-mono text-[14px] text-text-1">
            BTC{' '}
            <b className={isUp ? 'text-up' : 'text-down'}>
              {isUp ? 'above' : 'below'} ${num(strike, 0)}
            </b>{' '}
            <span className="text-text-3">· {timeLeft} left</span>
          </div>
          <button
            type="button"
            onClick={onBet}
            className={`rounded-md px-3.5 py-1.5 text-[12px] font-medium ring-1 ring-inset transition ${
              isUp
                ? 'bg-(--accent-soft) text-accent ring-(--accent-line) hover:bg-accent/20'
                : 'bg-down/10 text-down ring-down/30 hover:bg-down/20'
            }`}
          >
            Bet {isUp ? '↑' : '↓'}
          </button>
        </div>

        {/* The three reads: where it stands, if it moves, if it sits. */}
        <div className="mt-3.5 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          <Tile label={<Term plain="Chance now" pro="Fair chance" />}>
            <span className="tabular-nums text-text-1">{pct(fair0, 0)}</span>
            {/* maxWin is DOLLARS back on a $STAKE bet, so the multiple is maxWin/STAKE.
                Printing maxWin itself here read "200.02× payout" on an even-money bet,
                while the ladder called the same strike 1.95×. */}
            <span className="ml-1.5 text-[11px] text-text-3">{(maxWin / STAKE).toFixed(2)}× payout</span>
          </Tile>
          <Tile label={<Term plain="If BTC +$100" pro="Delta · per +$100" />}>
            <span className={`tabular-nums ${moveChancePts >= 0 ? 'text-up' : 'text-down'}`}>{signed(moveChancePts, 1)} pts</span>
            <span className="ml-1.5 text-[11px] text-text-3">mark {sUsd(moveUsd)}</span>
          </Tile>
          <ProOnly>
            {/* Gamma has always been computed and never shown, and vega is new. Both are
                per-$100 staked like every other figure here. Gamma is quoted per $100 of
                spot move because per-dollar-squared is unreadable at BTC's scale. */}
            <Tile label="Vega · per +1 vol pt">
              <span className={`tabular-nums ${vegaPts >= 0 ? 'text-up' : 'text-down'}`}>{signed(vegaPts, 1)} pts</span>
              <span className="ml-1.5 text-[11px] text-text-3">mark {sUsd(vegaUsd)}</span>
            </Tile>
            <Tile label="Gamma · per $100">
              <span className="tabular-nums text-text-2">{signed(gammaPts, 2)} pts</span>
              <span className="ml-1.5 text-[11px] text-text-3">delta change</span>
            </Tile>
          </ProOnly>
          <Tile label={<Term plain="If it sits still" pro="Theta · time decay" />}>
            <span className={`tabular-nums ${sitUsd >= 0 ? 'text-up' : 'text-down'}`}>{sitWin ? `wins ${sUsd(sitUsd)}` : `−$${STAKE}`}</span>
            <span className="ml-1.5 text-[11px] text-text-3">
              {greeks.tYears * 8760 >= 1 ? `${sUsd(thetaUsdHr)}/hr` : `by ${timeLeft}`}
            </span>
          </Tile>
        </div>

        {/* The payoff diagram — mark-now curve vs at-expiry step over a P&L field. */}
        <PayoffChart
          svgRef={svgRef}
          scenario={scenario}
          fair0={fair0}
          profit={profit}
          strike={strike}
          forward={forward}
          scrubF={scrubF}
          scrubActive={scrub != null}
          accent={accent}
          onScrub={scrubFromPointer}
        />

        {/* Scrubber + live readout. */}
        <div className="mt-2.5">
          <input
            type="range"
            min={Fmin}
            max={Fmax}
            step={(Fmax - Fmin) / 240}
            value={scrubF}
            onChange={(e) => setScrub(Number(e.target.value))}
            aria-label="Scrub the BTC price to test the payoff"
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/10"
            style={{ accentColor: accent }}
          />
          <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 font-mono text-[12px]">
            <span className="text-text-2">
              At <span className="tabular-nums text-text-1">${num(scrubF, 0)}</span>{' '}
              <span className={`tabular-nums ${scrubMovePct >= 0 ? 'text-up' : 'text-down'}`}>({signed(scrubMovePct, 1)}%)</span>
            </span>
            <span className="text-text-3">
              now <span className="tabular-nums text-text-1">${num(scrubMark, 0)}</span>{' '}
              <span className={`tabular-nums ${scrubPnl >= 0 ? 'text-up' : 'text-down'}`}>({sUsd(scrubPnl)})</span>
              <span className="mx-1.5 text-line">·</span>
              at expiry{' '}
              {scrubWin ? (
                <span className="tabular-nums text-up">wins ${num(maxWin, 0)} ({sUsd(profit)})</span>
              ) : (
                <span className="tabular-nums text-down">−${STAKE}</span>
              )}
            </span>
          </div>
          {scrub != null && (
            <button
              type="button"
              onClick={() => setScrub(null)}
              className="mt-1 text-[11px] text-text-3 underline-offset-2 transition-colors hover:text-text-1"
            >
              Reset to now
            </button>
          )}
        </div>

        <p className="mt-3 text-[11px] leading-relaxed text-text-3">
          Per $100 staked, before leverage. <span className="text-text-2">Mark</span> is the value if you exit now;{' '}
          <span className="text-text-2">at expiry</span> is the final all-or-nothing payoff. Holds today&apos;s surface — a
          real move reshapes it.
        </p>
      </div>
    </>
  );
}

function Tile({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="glass-inset rounded-lg px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wide text-text-3">{label}</div>
      <div className="mt-1 flex flex-wrap items-baseline font-mono text-[14px]">{children}</div>
    </div>
  );
}

// ——— The payoff diagram ———

const W = 640;
const H = 190;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 14;
const PAD_B = 22;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

const PayoffChart = ({
  svgRef,
  scenario,
  fair0,
  profit,
  strike,
  forward,
  scrubF,
  scrubActive,
  accent,
  onScrub,
}: {
  svgRef: RefObject<SVGSVGElement | null>;
  scenario: ScenarioPoint[];
  fair0: number;
  profit: number;
  strike: number;
  forward: number;
  scrubF: number;
  scrubActive: boolean;
  accent: string;
  onScrub: (clientX: number) => void;
}) => {
  const Fmin = scenario[0].forward;
  const Fmax = scenario[scenario.length - 1].forward;
  const pnlMax = Math.min(profit, MAX_CHART_PROFIT);
  const pnlMin = -STAKE;
  const padV = (pnlMax - pnlMin) * 0.1;
  const yTop = pnlMax + padV;
  const yBot = pnlMin - padV;

  const X = (f: number) => PAD_L + ((f - Fmin) / (Fmax - Fmin)) * PLOT_W;
  const Y = (v: number) => {
    const y = PAD_T + ((yTop - v) / (yTop - yBot)) * PLOT_H;
    return Math.min(H - PAD_B, Math.max(PAD_T, y)); // clip clamped longshots to the frame
  };
  const mPnl = (p: ScenarioPoint) => (STAKE * p.mark) / fair0 - STAKE;
  const ePnl = (p: ScenarioPoint) => (p.expiry ? profit : -STAKE);

  const markPts = scenario.map((p) => `${X(p.forward).toFixed(1)},${Y(mPnl(p)).toFixed(1)}`).join(' ');
  const expPts = scenario.map((p) => `${X(p.forward).toFixed(1)},${Y(ePnl(p)).toFixed(1)}`).join(' ');
  const markArea = `${X(Fmin).toFixed(1)},${(H - PAD_B).toFixed(1)} ${markPts} ${X(Fmax).toFixed(1)},${(H - PAD_B).toFixed(1)}`;

  const y0 = Y(0);
  const strikeIn = strike >= Fmin && strike <= Fmax;
  const gid = 'payoff-fill';

  const leftPct = (x: number) => `${(x / W) * 100}%`;
  const topPct = (y: number) => `${(y / H) * 100}%`;

  return (
    <div className="relative mt-3.5 select-none">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-47.5 w-full touch-none"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          onScrub(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) onScrub(e.clientX);
        }}
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity="0.22" />
            <stop offset="100%" stopColor={accent} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Profit / loss zones. */}
        <rect x={PAD_L} y={PAD_T} width={PLOT_W} height={Math.max(0, y0 - PAD_T)} fill="var(--up)" opacity={0.05} />
        <rect x={PAD_L} y={y0} width={PLOT_W} height={Math.max(0, H - PAD_B - y0)} fill="var(--down)" opacity={0.05} />

        {/* Area under the mark curve. */}
        <polygon points={markArea} fill={`url(#${gid})`} />

        {/* Break-even line. */}
        <line x1={PAD_L} y1={y0} x2={W - PAD_R} y2={y0} stroke="var(--text-3)" strokeWidth={1} strokeDasharray="3 3" opacity={0.5} />

        {/* At-expiry payoff (stepped, muted) and mark-now curve (solid, tone). */}
        <polyline points={expPts} fill="none" stroke="var(--text-3)" strokeWidth={1.25} strokeDasharray="4 3" opacity={0.7} />
        <polyline points={markPts} fill="none" stroke={accent} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {/* Strike + current-price guides. */}
        {strikeIn && <line x1={X(strike)} y1={PAD_T} x2={X(strike)} y2={H - PAD_B} stroke="var(--text-3)" strokeWidth={1} opacity={0.35} />}
        <line x1={X(forward)} y1={PAD_T} x2={X(forward)} y2={H - PAD_B} stroke="var(--text-2)" strokeWidth={1} opacity={0.55} />

        {/* Scrub marker. */}
        <line x1={X(scrubF)} y1={PAD_T} x2={X(scrubF)} y2={H - PAD_B} stroke={accent} strokeWidth={1.25} opacity={scrubActive ? 0.9 : 0} />
      </svg>

      {/* HTML label overlay (crisp under preserveAspectRatio="none"). */}
      <div className="pointer-events-none absolute inset-0 font-mono text-[10px] tabular-nums text-text-3">
        {strikeIn && (
          <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: leftPct(X(strike)), top: 2 }}>
            strike ${num(strike, 0)}
          </span>
        )}
        <span className="absolute -translate-x-1/2 whitespace-nowrap text-text-2" style={{ left: leftPct(X(forward)), bottom: 2 }}>
          now
        </span>
        {scrubActive && (
          <span
            className="absolute -translate-x-1/2 whitespace-nowrap rounded bg-bg-2 px-1 py-0.5 text-text-1 ring-1 ring-inset ring-line"
            style={{ left: leftPct(X(scrubF)), top: topPct(Math.max(PAD_T + 10, Y(0) - 22)) }}
          >
            ${num(scrubF, 0)}
          </span>
        )}
      </div>
    </div>
  );
};
