'use client';

/**
 * OptionsEdgeScanner — the cross-expiry value screener. Where the probability
 * ladder lets a trader eyeball ONE expiry, this sweeps EVERY open expiry × a dense
 * strike column × both sides and floats the standout edges to the top: strikes the
 * surface is charging LESS for than the same move has actually paid off on the
 * recent tape. One tap lights it on the surface + pre-fills the ticket; Bet places
 * it (on that strike's own market, even if it's a different expiry than the page's).
 *
 * The math is the pure `scanEdges` (lib/insights/edge-scan) — the SAME implied
 * (`upFair`) the ladder shows, so the two can't disagree. Honest by construction:
 * it's a recent base rate, not a forecast (see the footnote), and the sample count
 * backs every row.
 *
 * EVERY FIGURE HERE IS NET OF FEES, which changed what this board says. The protocol
 * fee is charged on notional, so it eats ~2.0-2.4 probability points at every strike;
 * the old screener admitted anything over +2 points GROSS and ranked by it, which put
 * break-even and losing trades at the top of a board headed "where the surface is
 * cheap". Edge, EV and payout are now quoted after the fee, and admission is on the
 * net edge. The gross edge is still shown beside it, because "beats the surface by 6,
 * keeps 3.8 after costs" is the honest way to say it.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { LuTrendingUp, LuTrendingDown, LuArrowUpDown, LuArrowUp, LuArrowDown } from 'react-icons/lu';
import { num, signed } from '@/lib/format';
import { expiryLabelShort as expiryLabel, scanEdges, type EdgeCandidate, type EdgeScanMarket } from '@/lib/insights';
import { feeRatesFor } from '@/lib/markets/v2-fees';
import { Term } from './vocab';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

/** How many top opportunities to show — a scannable board, not a data dump. */
const SHOW = 12;

type SortKey = 'edge' | 'ev' | 'payout' | 'chance' | 'expiry';

export function OptionsEdgeScanner({
  markets,
  pricers,
  closes,
  now,
  skewFeeBps = 0,
  onHighlight,
  onBet,
}: {
  markets: V2Market[];
  pricers: Record<string, LivePricer>;
  closes: number[] | null | undefined;
  now: number;
  /** Our own fee rate, from the on-chain FeeConfig. 0 when the router is off. */
  skewFeeBps?: number;
  onHighlight: (marketId: string, strike: number, isUp: boolean) => void;
  onBet: (marketId: string, strike: number, isUp: boolean) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'edge', dir: 'desc' });

  // Coarse clock so the heavy sweep (every strike × expiry × side) recomputes on a
  // slow cadence, not every 1s price tick — the edge barely moves second to second.
  const scanNow = Math.floor(now / 10_000) * 10_000;

  const pool = useMemo(() => {
    const scanMarkets: EdgeScanMarket[] = markets.flatMap((m) => {
      const p = pricers[m.expiry_market_id];
      return p
        ? [
            {
              marketId: m.expiry_market_id,
              expiryMs: m.expiry,
              admissionTickSize: m.admission_tick_size,
              pricer: { forward: p.forward, svi: p.svi },
              // base_fee is per-market, so the rate is read off each one rather
              // than assumed uniform across the board.
              feeRates: feeRatesFor(m, skewFeeBps),
            },
          ]
        : [];
    });
    return scanEdges({ markets: scanMarkets, closes, now: scanNow });
    // pricers identity changes on refresh; closes on reload — both intended triggers.
  }, [markets, pricers, closes, scanNow, skewFeeBps]);

  const rows = useMemo(() => sortCandidates(pool, sort).slice(0, SHOW), [pool, sort]);

  const toggle = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'expiry' ? 'asc' : 'desc' }));

  return (
    <section>
      <div className="mb-3 mt-1 flex items-center gap-2.5">
        <h2 className="text-[14px] font-semibold text-text-1">Edge scanner</h2>
        <span className="text-[10.5px] uppercase tracking-wide text-text-3">where the surface is cheap vs recent history, after costs</span>
        <span className="h-px flex-1 bg-gradient-to-r from-line to-transparent" />
      </div>

      <div className="glass overflow-x-auto rounded-lg p-4">
        {!closes ? (
          <div className="py-8 text-center text-[13px] text-text-3">Reading the recent tape…</div>
        ) : rows.length === 0 ? (
          <div className="py-8 text-center text-[13px] text-text-3">
            Nothing here clears its trading costs right now. The surface is priced in line with recent history. Check back as the tape moves.
          </div>
        ) : (
          <table className="w-full min-w-[720px] border-collapse">
            <thead>
              <tr className="text-[10.5px] uppercase tracking-wide text-text-3">
                <SortableTh label="Expiry" k="expiry" sort={sort} onClick={toggle} align="left" />
                <Th className="text-left">Strike</Th>
                <Th className="text-left">Side</Th>
                <SortableTh label={<Term plain="Chance" pro="P(win)" />} k="chance" sort={sort} onClick={toggle} />
                <Th><Term plain="Happened lately" pro="Realized hit-rate" /></Th>
                <SortableTh label={<Term plain="Edge after costs" pro="Net edge (pts)" />} k="edge" sort={sort} onClick={toggle} />
                <SortableTh label="EV" k="ev" sort={sort} onClick={toggle} />
                <SortableTh label={<Term plain="Payout" pro="Payout ×" />} k="payout" sort={sort} onClick={toggle} />
                <Th> </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <Row key={`${c.marketId}:${c.strike}:${c.isUp}`} c={c} now={scanNow} onHighlight={onHighlight} onBet={onBet} />
              ))}
            </tbody>
          </table>
        )}

        <div className="mt-3 flex flex-wrap justify-between gap-2 text-[11.5px] text-text-3">
          <span>
            <Term
              plain='"Edge after costs" = how many points cheaper the surface prices this than moves like it have paid off lately, once the fee is paid.'
              pro="Net edge = empirical hit-rate − implied − fee, in probability points. EV and payout are per dollar committed, after fees."
            />
          </span>
          <span>A recent base rate, not a forecast.</span>
        </div>
      </div>
    </section>
  );
}

function sortCandidates(pool: EdgeCandidate[], sort: { key: SortKey; dir: 'asc' | 'desc' }): EdgeCandidate[] {
  const val = (c: EdgeCandidate): number =>
    sort.key === 'edge' ? c.netEdgePts
    : sort.key === 'ev' ? c.evPct
    : sort.key === 'payout' ? c.netPayout
    : sort.key === 'chance' ? c.implied
    : c.expiryMs; // 'expiry'
  const sign = sort.dir === 'desc' ? -1 : 1;
  return [...pool].sort((a, b) => sign * (val(a) - val(b)));
}

function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <th className={`border-b border-line px-3.5 pb-2.5 text-right font-medium ${className}`}>{children}</th>;
}

function SortableTh({
  label,
  k,
  sort,
  onClick,
  align = 'right',
}: {
  label: ReactNode;
  k: SortKey;
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onClick: (k: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const active = sort.key === k;
  const Icon = !active ? LuArrowUpDown : sort.dir === 'desc' ? LuArrowDown : LuArrowUp;
  return (
    <th className={`border-b border-line px-3.5 pb-2.5 font-medium ${align === 'left' ? 'text-left' : 'text-right'}`}>
      <button
        type="button"
        onClick={() => onClick(k)}
        className={`inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-text-1 focus-visible:outline-none focus-visible:text-text-1 ${active ? 'text-text-1' : ''} ${align === 'right' ? 'flex-row-reverse' : ''}`}
      >
        <Icon size={11} className={active ? 'text-accent' : 'opacity-50'} />
        {label}
      </button>
    </th>
  );
}

function Row({
  c,
  now,
  onHighlight,
  onBet,
}: {
  c: EdgeCandidate;
  now: number;
  onHighlight: (marketId: string, strike: number, isUp: boolean) => void;
  onBet: (marketId: string, strike: number, isUp: boolean) => void;
}) {
  const up = c.isUp;
  const dirColor = up ? 'text-up' : 'text-down';
  return (
    <tr
      onClick={() => onHighlight(c.marketId, c.strike, c.isUp)}
      className="group cursor-pointer border-b border-line/60 font-mono text-[13px] transition hover:bg-white/2.5"
    >
      <td className="px-3.5 py-2.5 text-left tabular-nums text-text-2">{expiryLabel(c.expiryMs, now)}</td>
      <td className="px-3.5 py-2.5 text-left tabular-nums text-text-1">${num(c.strike, 0)}</td>
      <td className="px-3.5 py-2.5 text-left">
        <span className={`inline-flex items-center gap-1 text-[12px] font-semibold ${dirColor}`}>
          {up ? <LuTrendingUp size={13} /> : <LuTrendingDown size={13} />}
          {up ? 'UP' : 'DOWN'}
        </span>
      </td>
      <td className="px-3.5 py-2.5 text-right tabular-nums">
        <span className="inline-flex items-center justify-end gap-2">
          <span className="h-1.5 w-14 overflow-hidden rounded border border-line bg-bg-3">
            <span className="block h-full bg-accent/70" style={{ width: `${c.implied * 100}%` }} />
          </span>
          {(c.implied * 100).toFixed(0)}%
        </span>
      </td>
      <td
        className="px-3.5 py-2.5 text-right tabular-nums text-text-2"
        title={`${c.samples.toLocaleString('en-US')} recent windows, ${c.independentWindows.toLocaleString('en-US')} of them non-overlapping`}
      >
        {(c.empirical * 100).toFixed(0)}%
      </td>
      {/* Net first, because it is the number that decides the trade. Gross sits
          under it so the fee's bite is visible rather than silently applied. */}
      <td className="px-3.5 py-2.5 text-right tabular-nums">
        <span className="font-semibold text-up">+{c.netEdgePts.toFixed(1)} pts</span>
        <span className="ml-1.5 text-[11px] text-text-3">of {c.edgePts.toFixed(1)}</span>
      </td>
      <td className="px-3.5 py-2.5 text-right tabular-nums text-up">{signed(c.evPct, 0)}%</td>
      <td className="px-3.5 py-2.5 text-right tabular-nums">{c.netPayout.toFixed(2)}×</td>
      <td className="px-3.5 py-2.5 text-right">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onBet(c.marketId, c.strike, c.isUp);
          }}
          className={`rounded-md px-3 py-1 font-sans text-[12px] font-medium ring-1 ring-inset transition ${
            up
              ? 'bg-(--accent-soft) text-accent ring-(--accent-line) hover:bg-accent/20'
              : 'bg-down/10 text-down ring-down/30 hover:bg-down/20'
          }`}
        >
          Bet {up ? '↑' : '↓'}
        </button>
      </td>
    </tr>
  );
}
