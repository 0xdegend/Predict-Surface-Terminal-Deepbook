'use client';

/**
 * Active-oracle table — now a control surface, not just a readout. Clicking a
 * row selects that oracle on the 3-D surface (the marker jumps to its ATM node)
 * and loads it into the trade ticket, pre-filled at the at-the-money strike.
 * Rows with a live SVI snapshot are pickable; the rest render dimmed.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import gsap from 'gsap';
import { LuChevronLeft, LuChevronRight } from 'react-icons/lu';
import { useSurfaceStore } from '@/lib/store/surface-store';
import { useNow } from '@/lib/hooks/use-now';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { useLiveOracleData } from '@/lib/hooks/use-live-oracle-data';
import { snapStrikeToTick } from '@/lib/keys';
import { toFloat } from '@/config/scale';
import { impliedVol, timeToExpiryYears } from '@/lib/svi/svi';
import { price, dateUTC, countdown, num, pct, shortId } from '@/lib/format';
import type { SmileInput } from '@/lib/svi/surface';
import type { Oracle } from '@/lib/api/types';

/** Markets inside this window are about to settle — minting may revert. */
const CLOSING_SOON_MS = 120_000;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function OracleTable({
  oracles: initialOracles,
  inputs: initialInputs,
  serverNow,
}: {
  oracles: Oracle[];
  inputs: SmileInput[];
  serverNow: number;
}) {
  const selection = useSurfaceStore((s) => s.selection);
  const select = useSurfaceStore((s) => s.select);
  const now = useNow(serverNow);
  // Live set — picks up newly opened expiries and drops settled ones server-side
  // (the clock drops expired-but-unsettled below); no reload needed.
  const { oracles, inputs } = useLiveOracleData(initialOracles, initialInputs);

  // Paginate so the dense grid never becomes an endless wall — fewer rows on a
  // phone where vertical space is precious, a fuller page on desktop.
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const pageSize = isDesktop ? 9 : 6;
  const [page, setPage] = useState(0);

  const bodyRef = useRef<HTMLTableSectionElement>(null);

  // Entrance choreography (§10.6): rows rise + fade in with a tight stagger when
  // the table first paints (and again on each Cards↔Table switch, since this
  // component remounts). One intentional moment — not idle hover wiggle.
  useEffect(() => {
    if (prefersReducedMotion() || !bodyRef.current) return;
    const rows = bodyRef.current.querySelectorAll('tr');
    if (rows.length === 0) return;
    const ctx = gsap.context(() => {
      gsap.from(rows, {
        opacity: 0,
        y: 8,
        duration: 0.4,
        ease: 'power2.out',
        stagger: 0.035,
        clearProps: 'opacity,transform',
      });
    }, bodyRef);
    return () => ctx.revert();
    // Mount-only: live data updates shouldn't re-trigger the entrance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inputById = useMemo(() => {
    const m = new Map<string, SmileInput>();
    for (const i of inputs) m.set(i.oracle.oracle_id, i);
    return m;
  }, [inputs]);

  // Precise, fast confirmation flash on the picked row (§10.6: selection = a
  // crisp highlight, never a bounce). Cleared so the row's own state colour returns.
  function flashRow(el: HTMLElement) {
    if (prefersReducedMotion()) return;
    // Concrete rgba (the teal accent) so GSAP interpolates the fade cleanly —
    // it can't parse color-mix() as a tween start value.
    gsap.fromTo(
      el,
      { backgroundColor: 'rgba(77, 214, 176, 0.22)' },
      { backgroundColor: 'rgba(77, 214, 176, 0)', duration: 0.6, ease: 'power2.out', clearProps: 'backgroundColor' },
    );
  }

  function pickOracle(input: SmileInput) {
    const { oracle, forward } = input;
    // At-the-money: snap the forward to the nearest tradeable grid strike.
    const strikeScaled = snapStrikeToTick(BigInt(Math.round(forward * 1e9)), oracle);
    select({
      oracleId: oracle.oracle_id,
      expiry: oracle.expiry,
      strikeScaled: strikeScaled.toString(),
      strike: toFloat(Number(strikeScaled)),
      isUp: true,
    });
    // Scroll the ticket into view on narrow layouts where it sits below.
    if (typeof document !== 'undefined') {
      document.getElementById('trade-ticket')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // Once a market expires it's no longer tradeable — drop it from the picker so
  // the live list stays tight (any position you hold in it lives in Portfolio).
  // `now` ticks each second, so rows leave the table the moment they expire.
  const visible = oracles.filter((o) => o.expiry > now);
  const hiddenCount = oracles.length - visible.length;

  // Clamp the page in render (no effect) so a shrinking list — expiries dropping
  // each second, or the page size halving on a viewport change — can never
  // strand us on an empty page.
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pageStart = safePage * pageSize;
  const pageRows = visible.slice(pageStart, pageStart + pageSize);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-baseline justify-between">
        <h2 className="flex items-center gap-2">
          <span className="eyebrow">Active markets</span>
          {visible.length > 0 && (
            <span className="rounded-full bg-[var(--bg-3)] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-text-2">
              {visible.length}
            </span>
          )}
        </h2>
        <span className="font-mono text-[10px] text-text-3">
          {hiddenCount > 0 && <span className="mr-3">{hiddenCount} expired hidden</span>}
          click a row → loads the ticket
        </span>
      </div>

      {visible.length === 0 ? (
        <div className="glass-card mt-3 flex min-h-[12rem] flex-1 flex-col items-center justify-center gap-1 px-4 py-10 text-center">
          <span className="text-[12px] text-text-2">No active markets right now</span>
          <span className="text-[11px] text-text-3">Waiting for the next expiry to open.</span>
        </div>
      ) : (
      // Frosted glass shell — the table lives inside a translucent card so it
      // matches the portfolio's glassmorphism. `flex-1` stretches the card to fill
      // the column so a short list never leaves a void below it; `overflow-hidden`
      // clips rows to the rounded corners and the inner scroll box (flex-1) is the
      // sticky container, so the header sticks to the TOP OF THIS BOX, never the page.
      <div className="glass-card mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="scroll-quiet min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse font-mono text-[11px] tabular-nums sm:text-[12px]">
          <thead>
            <tr className="sticky top-0 z-10 text-left text-[10px] uppercase tracking-wider text-text-3 [&>th]:border-b [&>th]:border-line [&>th]:bg-[color-mix(in_srgb,var(--bg-1)_82%,transparent)] [&>th]:backdrop-blur-xl">
              <Th>Underlying</Th>
              <Th>Expiry</Th>
              <Th>TTL</Th>
              <Th className="text-right">Forward</Th>
              <Th className="text-right">ATM IV</Th>
              <Th className="text-right">Min strike</Th>
              <Th className="text-right">Tick</Th>
              <Th className="text-right">Oracle</Th>
            </tr>
          </thead>
          <tbody ref={bodyRef} className="row-divider">
            {pageRows.map((o) => {
              const input = inputById.get(o.oracle_id);
              const selected = selection?.oracleId === o.oracle_id;
              const msLeft = o.expiry - now;
              const closingSoon = msLeft < CLOSING_SOON_MS;
              const urgent = !closingSoon && msLeft < 15 * 60_000;
              const pickable = !!input;
              const atmIv = input
                ? impliedVol(input.forward, input.forward, input.svi, Math.max(timeToExpiryYears(o.expiry, now), 0))
                : null;
              // Split "Jun 10 23:30" into date + time so the cell renders two
              // clean, non-wrapping lines instead of a 4-line space-wrap on mobile.
              const exp = dateUTC(o.expiry, false);
              const expSplit = exp.lastIndexOf(' ');
              const expDate = exp.slice(0, expSplit);
              const expTime = exp.slice(expSplit + 1);
              return (
                <tr
                  key={o.oracle_id}
                  onClick={pickable ? (e) => { flashRow(e.currentTarget); pickOracle(input!); } : undefined}
                  tabIndex={pickable ? 0 : undefined}
                  onKeyDown={
                    pickable
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            flashRow(e.currentTarget);
                            pickOracle(input!);
                          }
                        }
                      : undefined
                  }
                  aria-selected={selected}
                  className={[
                    'group transition-colors',
                    pickable
                      ? 'cursor-pointer hover:bg-white/[0.035] focus-visible:bg-white/5 focus-visible:outline-none'
                      : 'opacity-40',
                    selected ? 'bg-[var(--accent-soft)]' : '',
                  ].join(' ')}
                >
                  <Td className="text-text-1">
                    <span className="relative inline-flex items-center gap-2.5 pl-2.5">
                      {/* selected accent rail */}
                      <span
                        className={`absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full transition-colors ${
                          selected ? 'bg-accent' : 'bg-transparent'
                        }`}
                      />
                      <span className="font-medium">{o.underlying_asset}</span>
                    </span>
                  </Td>
                  <Td className="text-text-2">
                    <span className="flex flex-col whitespace-nowrap leading-tight">
                      <span>{expDate}</span>
                      <span className="text-text-3">
                        {expTime}
                        <span className="ml-0.5 text-[9px] tracking-wide">UTC</span>
                      </span>
                    </span>
                  </Td>
                  <Td>
                    {closingSoon ? (
                      <span className="inline-block whitespace-nowrap rounded bg-[var(--down-soft)] px-1.5 py-0.5 text-down">
                        {countdown(o.expiry, now)}
                      </span>
                    ) : urgent ? (
                      <span className="inline-block whitespace-nowrap rounded bg-[var(--warn-soft)] px-1.5 py-0.5 text-warn">
                        {countdown(o.expiry, now)}
                      </span>
                    ) : (
                      <span className="whitespace-nowrap text-text-2">{countdown(o.expiry, now)}</span>
                    )}
                  </Td>
                  <Td className="text-right text-text-2">{input ? price(input.forward, 0) : '—'}</Td>
                  <Td className="text-right text-text-1">{atmIv != null ? pct(atmIv, 1) : '—'}</Td>
                  <Td className="text-right text-text-3">{price(toFloat(o.min_strike), 0)}</Td>
                  <Td className="text-right text-text-3">{num(toFloat(o.tick_size), 2)}</Td>
                  <Td className="text-right text-text-3 group-hover:text-text-2">
                    {shortId(o.oracle_id)}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>

        {pageCount > 1 && (
          <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2.5">
            <span className="font-mono text-[10px] tabular-nums text-text-3">
              {pageStart + 1}–{pageStart + pageRows.length} of {visible.length}
            </span>
            <div className="flex items-center gap-1">
              <PagerArrow
                dir="prev"
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
              />
              <span className="px-1.5 font-mono text-[11px] tabular-nums text-text-2">
                {safePage + 1}
                <span className="text-text-3"> / {pageCount}</span>
              </span>
              <PagerArrow
                dir="next"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage(safePage + 1)}
              />
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  );
}

function PagerArrow({
  dir,
  disabled,
  onClick,
}: {
  dir: 'prev' | 'next';
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === 'prev' ? 'Previous page' : 'Next page'}
      className="ctrl-soft inline-flex h-7 w-7 items-center justify-center rounded-md text-text-2 disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {dir === 'prev' ? <LuChevronLeft size={14} /> : <LuChevronRight size={14} />}
    </button>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-2.5 py-2.5 font-normal sm:px-3.5 sm:py-3 ${className}`}>{children}</th>;
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-2.5 py-2.5 sm:px-3.5 sm:py-3 ${className}`}>{children}</td>;
}
