'use client';

/**
 * StrategyBuilder — compose several legs on ONE expiry, see the combined shape, and
 * place the whole basket in one go. The last of the three options-page power tools.
 *
 * Because every leg is a LONG binary/range (bounded downside, no shorting), the
 * combined payoff at expiry is a clean step function and the four desk numbers —
 * net cost, max win, max loss, breakevens — are exact, plus a surface-derived
 * chance of profit (all from lib/strategy). The diagram overlays the smooth
 * mark-now curve on the stepped at-expiry payoff, the same language as the Phase-2
 * panel. "Place all" mints each leg through the proven budget-mint path
 * (lib/sui/v2/strategy-mint), depositing the shortfall exactly once.
 *
 * Presets (breakout / ladders / pin) seed a shape in one tap so the multi-leg idea
 * is discoverable; from there a trader tweaks stakes, adds or removes legs. 1× only
 * — the ticket owns leverage for a single bet.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { LuTrendingUp, LuTrendingDown, LuArrowLeftRight, LuPlus, LuX } from 'react-icons/lu';
import { num, pct } from '@/lib/format';
import { toFloat, fromFloat } from '@/config/scale';
import { snapStrikeToAdmission } from '@/lib/sui/v2/ticks';
import { planStrategyMints } from '@/lib/sui/v2/strategy-mint';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import {
  buildStrategy,
  strategyStats,
  legRepricers,
  pnlAt,
  markAt,
  presetLegs,
  PRESETS,
  type Leg,
  type PresetKind,
} from '@/lib/strategy/strategy';
import { Term } from './vocab';
import type { V2Market } from '@/lib/api/v2/types';
import type { SviFloat } from '@/lib/svi/svi';

const DEFAULT_STAKE = 5;
const sUsd = (v: number) => `${v < 0 ? '−' : '+'}$${num(Math.abs(v), 0)}`;

/** A leg without its id — distributes over the union (unlike `Omit<Leg, 'id'>`,
 *  which would collapse to the shared keys only). */
type DraftLeg =
  | { kind: 'binary'; strike: number; isUp: boolean; stake: number }
  | { kind: 'range'; lower: number; higher: number; stake: number };

export function StrategyBuilder({
  market,
  pricer,
}: {
  market: V2Market | null;
  pricer: { forward: number; svi: SviFloat } | null | undefined;
}) {
  const acct = usePredictAccountV2();
  const [legs, setLegs] = useState<Leg[]>([]);
  const [adding, setAdding] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const idRef = useRef(0);
  const nextId = () => `leg-${++idRef.current}`;

  const ready = !!market && !!pricer && pricer.forward > 0;
  const forward = pricer?.forward ?? 0;
  const svi = pricer?.svi ?? null;
  const feeRate = market ? toFloat(market.base_fee) : 0;
  const admissionTickSize = market ? BigInt(market.admission_tick_size) : 1n;
  const admStep = market ? toFloat(market.admission_tick_size) : 1;
  const snap = (v: number) => toFloat(snapStrikeToAdmission(fromFloat(v), admissionTickSize));
  const atm = ready ? snap(forward) : 0;
  // A grid-aligned preset width ~0.4% of spot — wide enough to be a real strangle.
  const width = ready ? Math.max(admStep, Math.round((forward * 0.004) / admStep) * admStep) : admStep;

  const model = useMemo(() => {
    if (!ready || !svi || legs.length === 0) return null;
    const strategy = buildStrategy(legs, { forward, svi }, feeRate);
    const stats = strategyStats(strategy);
    const reprs = legRepricers(strategy);
    const bps = strategy.breakpoints;
    const lo = bps.length ? Math.min(bps[0], forward) : forward;
    const hi = bps.length ? Math.max(bps[bps.length - 1], forward) : forward;
    const span = Math.max(hi - lo, forward * 0.03);
    const pad = span * 0.18;
    const xMin = lo - pad;
    const xMax = hi + pad;
    const N = 140;
    const pts = Array.from({ length: N + 1 }, (_, i) => {
      const x = xMin + ((xMax - xMin) * i) / N;
      return { x, expiry: pnlAt(strategy, x), mark: markAt(strategy, reprs, x) };
    });
    return { strategy, stats, xMin, xMax, pts };
  }, [ready, svi, legs, forward, feeRate]);

  if (!ready || !market || !pricer) return null;

  function applyPreset(kind: PresetKind) {
    setLegs(presetLegs(kind, atm, width, DEFAULT_STAKE).map((l) => ({ ...l, id: nextId() })));
    setProgress(null);
    setPlaceError(null);
  }
  function addLeg(leg: DraftLeg) {
    setLegs((ls) => [...ls, { ...leg, id: nextId() }]);
    setAdding(false);
  }
  function removeLeg(id: string) {
    setLegs((ls) => ls.filter((l) => l.id !== id));
  }
  function setStake(id: string, stake: number) {
    setLegs((ls) => ls.map((l) => (l.id === id ? { ...l, stake } : l)));
  }

  // Placement guards: the mints deposit any shortfall from the wallet, so the real
  // ceiling is the wallet DUSDC covering the total deposit.
  const plan = model ? planStrategyMints({ market, pricer, legs, balanceBase: acct.balanceBase }) : null;
  const insufficient =
    !!plan && acct.walletDusdcBase !== undefined && acct.walletDusdcBase < plan.totalDepositBase;
  const canPlace = !!plan && plan.allValid && !insufficient && !placing && !acct.busy;

  async function placeAll() {
    if (placing || !market || !pricer) return;
    if (!acct.wrapperExists) {
      await acct.createAccount();
      return;
    }
    // Re-plan against the live balance at click time.
    const fresh = planStrategyMints({ market, pricer, legs, balanceBase: acct.balanceBase });
    if (!fresh.allValid) return;
    setPlacing(true);
    setPlaceError(null);
    setProgress({ done: 0, total: fresh.plans.length });
    let done = 0;
    for (const p of fresh.plans) {
      const digest = await acct.mintBudget(p.params, { silentSuccess: true });
      if (!digest) {
        setPlaceError(acct.error ?? 'A leg could not be placed — the remaining legs were not sent.');
        setPlacing(false);
        setProgress({ done, total: fresh.plans.length });
        return;
      }
      done += 1;
      setProgress({ done, total: fresh.plans.length });
    }
    setPlacing(false);
  }

  const stats = model?.stats;
  const netCost = stats?.netCost ?? 0;

  return (
    <section>
      <div className="mb-3 mt-1 flex items-center gap-2.5">
        <h2 className="text-[14px] font-semibold text-text-1">Strategy builder</h2>
        <span className="text-[10.5px] uppercase tracking-wide text-text-3">
          <Term plain="combine a few bets into one shape" pro="multi-leg payoff builder" />
        </span>
        <span className="h-px flex-1 bg-linear-to-r from-line to-transparent" />
      </div>

      <div className="glass rounded-lg p-4">
        {/* Presets. */}
        <div className="flex flex-wrap items-center gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.kind}
              type="button"
              onClick={() => applyPreset(p.kind)}
              title={p.blurb}
              className="rounded-md bg-bg-2 px-2.5 py-1 text-[12px] text-text-2 ring-1 ring-inset ring-line transition hover:text-text-1"
            >
              {p.label}
            </button>
          ))}
          <span className="mx-0.5 h-4 w-px bg-line" />
          <button
            type="button"
            onClick={() => setAdding((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md bg-(--accent-soft) px-2.5 py-1 text-[12px] text-accent ring-1 ring-inset ring-(--accent-line) transition hover:bg-accent/20"
          >
            <LuPlus size={13} /> Add leg
          </button>
          {legs.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setLegs([]);
                setProgress(null);
                setPlaceError(null);
              }}
              className="ml-auto text-[11px] text-text-3 underline-offset-2 transition-colors hover:text-text-1"
            >
              Clear
            </button>
          )}
        </div>

        {adding && <AddLegForm atm={atm} width={width} snap={snap} onAdd={addLeg} onCancel={() => setAdding(false)} />}

        {legs.length === 0 ? (
          <p className="mt-4 text-[13px] leading-relaxed text-text-3">
            Pick a preset or add a leg to build a custom payoff. Every leg is a plain up/down or range bet on this expiry —
            stacked, they make shapes a single bet can&apos;t.
          </p>
        ) : (
          <>
            {/* Legs. */}
            <div className="mt-3 flex flex-col divide-y divide-line/60">
              {model!.strategy.legs.map((e) => (
                <LegRow key={e.leg.id} leg={e.leg} prob={e.prob} payout={e.payout} onStake={setStake} onRemove={removeLeg} />
              ))}
            </div>

            {/* The combined payoff diagram. */}
            <StrategyChart pts={model!.pts} xMin={model!.xMin} xMax={model!.xMax} stats={model!.stats} forward={forward} />

            {/* The four desk numbers + chance of profit. */}
            <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <Stat label="You pay">
                <span className="tabular-nums text-text-1">${num(netCost, 2)}</span>
              </Stat>
              <Stat label="Max win">
                <span className="tabular-nums text-up">{sUsd(stats!.maxWin)}</span>
              </Stat>
              <Stat label="Max loss">
                <span className="tabular-nums text-down">{sUsd(stats!.maxLoss)}</span>
              </Stat>
              <Stat label={<Term plain="Chance of profit" pro="P(profit)" />}>
                <span className="tabular-nums text-text-1">{pct(stats!.chanceOfProfit, 0)}</span>
              </Stat>
            </div>
            <div className="mt-2 text-[11.5px] text-text-3">
              Breakeven{stats!.breakevens.length === 1 ? '' : 's'}:{' '}
              {stats!.breakevens.length ? (
                <span className="tabular-nums text-text-2">{stats!.breakevens.map((b) => `$${num(b, 0)}`).join(' · ')}</span>
              ) : (
                <span className="text-text-3">none in range</span>
              )}
            </div>

            {/* Place all. */}
            <div className="mt-4 flex flex-col gap-2">
              <PlaceButton
                acct={acct}
                legs={legs}
                netCost={netCost}
                canPlace={canPlace}
                insufficient={insufficient}
                placing={placing}
                progress={progress}
                onPlace={placeAll}
              />
              {placeError && (
                <p className="glass-error rounded-md px-3 py-2 text-[11.5px] leading-relaxed text-down">{placeError}</p>
              )}
              {progress && progress.done === progress.total && !placeError && !placing && (
                <p className="text-[11.5px] text-up">Placed {progress.total} bet{progress.total === 1 ? '' : 's'}. See them in your portfolio.</p>
              )}
              <p className="text-[11px] leading-relaxed text-text-3">
                Each leg is placed as its own 1× bet{acct.gasless ? ', signed instantly' : ', one wallet approval each'}. Cost is
                an estimate; your wallet shows the exact amount. Max loss is the whole premium.
              </p>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function Stat({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="glass-inset rounded-lg px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wide text-text-3">{label}</div>
      <div className="mt-1 font-mono text-[15px]">{children}</div>
    </div>
  );
}

function LegRow({
  leg,
  prob,
  payout,
  onStake,
  onRemove,
}: {
  leg: Leg;
  prob: number;
  payout: number;
  onStake: (id: string, stake: number) => void;
  onRemove: (id: string) => void;
}) {
  const chip =
    leg.kind === 'range' ? (
      <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-accent">
        <LuArrowLeftRight size={13} /> RANGE
      </span>
    ) : leg.isUp ? (
      <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-up">
        <LuTrendingUp size={13} /> UP
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-down">
        <LuTrendingDown size={13} /> DOWN
      </span>
    );
  const level = leg.kind === 'range' ? `$${num(leg.lower, 0)}–$${num(leg.higher, 0)}` : `$${num(leg.strike, 0)}`;
  return (
    <div className="flex items-center gap-2.5 py-2 font-mono text-[12px]">
      <span className="w-20 shrink-0">{chip}</span>
      <span className="min-w-0 flex-1 truncate tabular-nums text-text-1">{level}</span>
      <span className="hidden shrink-0 tabular-nums text-text-3 sm:inline">
        {(prob * 100).toFixed(0)}% · {payout.toFixed(2)}×
      </span>
      <div className="ctrl-soft inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 focus-within:border-white/20">
        <span className="text-[10px] text-text-3">$</span>
        <input
          type="text"
          inputMode="decimal"
          value={String(leg.stake)}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '' || /^\d*\.?\d*$/.test(v)) onStake(leg.id, Number(v) || 0);
          }}
          aria-label="Leg stake"
          className="w-12 bg-transparent text-right tabular-nums text-text-1 outline-none"
        />
      </div>
      <button
        type="button"
        onClick={() => onRemove(leg.id)}
        aria-label="Remove leg"
        className="shrink-0 rounded p-1 text-text-3 transition-colors hover:text-down"
      >
        <LuX size={14} />
      </button>
    </div>
  );
}

function AddLegForm({
  atm,
  width,
  snap,
  onAdd,
  onCancel,
}: {
  atm: number;
  width: number;
  snap: (v: number) => number;
  onAdd: (leg: DraftLeg) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<'up' | 'down' | 'range'>('up');
  const [a, setA] = useState(String(Math.round(atm)));
  const [b, setB] = useState(String(Math.round(atm + 2 * width)));
  const [stake, setStake] = useState(String(DEFAULT_STAKE));

  const parse = (v: string): number | null => {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const aN = parse(a);
  const bN = parse(b);
  const sN = parse(stake);
  const ready = sN != null && aN != null && (kind !== 'range' || (bN != null && aN !== bN));

  function submit() {
    if (!ready || aN == null || sN == null) return;
    if (kind === 'range' && bN != null) {
      const lo = snap(Math.min(aN, bN));
      let hi = snap(Math.max(aN, bN));
      if (hi === lo) hi = lo + width;
      onAdd({ kind: 'range', lower: lo, higher: hi, stake: sN });
    } else {
      onAdd({ kind: 'binary', strike: snap(aN), isUp: kind === 'up', stake: sN });
    }
  }

  const kindBtn = (k: 'up' | 'down' | 'range', label: string) => (
    <button
      key={k}
      type="button"
      onClick={() => setKind(k)}
      aria-pressed={kind === k}
      className={`flex-1 rounded-md py-1.5 text-[11px] font-medium uppercase tracking-wider transition-colors ${
        kind === k ? 'border border-up/40 bg-(--accent-soft) text-accent' : 'ctrl-soft text-text-3'
      }`}
    >
      {label}
    </button>
  );

  const field = (value: string, set: (v: string) => void, label: string) => (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-text-3">{label}</span>
      <div className="ctrl-soft flex items-center gap-1 rounded-md px-2 py-1.5 focus-within:border-white/20">
        <span className="text-[10px] text-text-3">$</span>
        <input
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => set(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          className="w-full min-w-0 bg-transparent text-right font-mono tabular-nums text-text-1 outline-none"
        />
      </div>
    </label>
  );

  return (
    <div className="mt-3 flex flex-col gap-2.5 rounded-lg border border-line bg-bg-1 p-3">
      <div className="flex gap-1.5">
        {kindBtn('up', 'Up')}
        {kindBtn('down', 'Down')}
        {kindBtn('range', 'Range')}
      </div>
      <div className="flex items-end gap-2">
        {field(a, setA, kind === 'range' ? 'Low' : 'Strike')}
        {kind === 'range' && field(b, setB, 'High')}
        {field(stake, setStake, 'Stake')}
      </div>
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="text-[11px] text-text-3 transition-colors hover:text-text-1">
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!ready}
          className={`rounded-md px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider transition-colors ${
            ready ? 'bg-(--accent-soft) text-accent ring-1 ring-inset ring-(--accent-line)' : 'ctrl-soft text-text-3 opacity-60'
          }`}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function PlaceButton({
  acct,
  legs,
  netCost,
  canPlace,
  insufficient,
  placing,
  progress,
  onPlace,
}: {
  acct: ReturnType<typeof usePredictAccountV2>;
  legs: Leg[];
  netCost: number;
  canPlace: boolean;
  insufficient: boolean;
  placing: boolean;
  progress: { done: number; total: number } | null;
  onPlace: () => void;
}) {
  const base =
    'w-full rounded-lg py-2.5 text-[13px] font-semibold ring-1 ring-inset transition disabled:opacity-50';
  const enabled = 'bg-(--accent-soft) text-accent ring-(--accent-line) hover:bg-accent/20';

  if (!acct.owner) {
    return (
      <button type="button" disabled className={`${base} bg-bg-2 text-text-3 ring-line`}>
        Connect a wallet to place
      </button>
    );
  }
  if (!acct.wrapperExists) {
    return (
      <button type="button" onClick={onPlace} disabled={!!acct.busy} className={`${base} ${enabled}`}>
        {acct.busy === 'create' ? 'Creating account…' : 'Create trading account'}
      </button>
    );
  }
  const label = placing
    ? progress
      ? `Placing ${progress.done + 1}/${progress.total}…`
      : 'Placing…'
    : insufficient
      ? 'Not enough DUSDC'
      : `Place ${legs.length} bet${legs.length === 1 ? '' : 's'} · $${num(netCost, 0)}`;
  return (
    <button type="button" onClick={onPlace} disabled={!canPlace} className={`${base} ${enabled}`}>
      {label}
    </button>
  );
}

// ——— The combined payoff diagram ———

const W = 640;
const H = 210;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 14;
const PAD_B = 22;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

function StrategyChart({
  pts,
  xMin,
  xMax,
  stats,
  forward,
}: {
  pts: { x: number; expiry: number; mark: number }[];
  xMin: number;
  xMax: number;
  stats: { maxWin: number; maxLoss: number; netCost: number; breakevens: number[] };
  forward: number;
}) {
  // Cap the upside so a longshot leg can't flatten the loss band; clip to frame.
  const yMax = Math.max(1, Math.min(stats.maxWin, stats.netCost * 6));
  const yMin = Math.min(-1, stats.maxLoss);
  const padV = (yMax - yMin) * 0.12;
  const yTop = yMax + padV;
  const yBot = yMin - padV;

  const X = (x: number) => PAD_L + ((x - xMin) / (xMax - xMin)) * PLOT_W;
  const Y = (v: number) => {
    const y = PAD_T + ((yTop - v) / (yTop - yBot)) * PLOT_H;
    return Math.min(H - PAD_B, Math.max(PAD_T, y));
  };

  const markPts = pts.map((p) => `${X(p.x).toFixed(1)},${Y(p.mark).toFixed(1)}`).join(' ');
  const expPts = pts.map((p) => `${X(p.x).toFixed(1)},${Y(p.expiry).toFixed(1)}`).join(' ');
  const markArea = `${X(xMin).toFixed(1)},${(H - PAD_B).toFixed(1)} ${markPts} ${X(xMax).toFixed(1)},${(H - PAD_B).toFixed(1)}`;
  const y0 = Y(0);
  const leftPct = (x: number) => `${(x / W) * 100}%`;

  return (
    <div className="relative mt-3.5 select-none">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-52.5 w-full">
        <defs>
          <linearGradient id="strat-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.2" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Profit / loss zones. */}
        <rect x={PAD_L} y={PAD_T} width={PLOT_W} height={Math.max(0, y0 - PAD_T)} fill="var(--up)" opacity={0.05} />
        <rect x={PAD_L} y={y0} width={PLOT_W} height={Math.max(0, H - PAD_B - y0)} fill="var(--down)" opacity={0.05} />

        <polygon points={markArea} fill="url(#strat-fill)" />

        {/* Break-even line. */}
        <line x1={PAD_L} y1={y0} x2={W - PAD_R} y2={y0} stroke="var(--text-3)" strokeWidth={1} strokeDasharray="3 3" opacity={0.5} />

        {/* At-expiry payoff (stepped, muted) + mark-now (solid accent). */}
        <polyline points={expPts} fill="none" stroke="var(--text-3)" strokeWidth={1.25} strokeDasharray="4 3" opacity={0.75} />
        <polyline points={markPts} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {/* Current price. */}
        <line x1={X(forward)} y1={PAD_T} x2={X(forward)} y2={H - PAD_B} stroke="var(--text-2)" strokeWidth={1} opacity={0.55} />

        {/* Breakeven guides. */}
        {stats.breakevens
          .filter((b) => b >= xMin && b <= xMax)
          .map((b) => (
            <line key={b} x1={X(b)} y1={PAD_T} x2={X(b)} y2={H - PAD_B} stroke="var(--accent)" strokeWidth={1} strokeDasharray="2 3" opacity={0.5} />
          ))}
      </svg>

      <div className="pointer-events-none absolute inset-0 font-mono text-[10px] tabular-nums text-text-3">
        <span className="absolute -translate-x-1/2 whitespace-nowrap text-text-2" style={{ left: leftPct(X(forward)), bottom: 2 }}>
          now ${num(forward, 0)}
        </span>
        {stats.breakevens
          .filter((b) => b >= xMin && b <= xMax)
          .map((b) => (
            <span key={b} className="absolute -translate-x-1/2 whitespace-nowrap text-accent" style={{ left: leftPct(X(b)), top: 2 }}>
              ${num(b, 0)}
            </span>
          ))}
      </div>
    </div>
  );
}
