'use client';

/**
 * V2MarketTable — the dense, table view of active markets for the new
 * deployment (legacy OracleTable's role). A control surface: clicking a row
 * selects that market into the shared trade store, which the hero, odds panel,
 * and ticket all read. Columns are the ones that carry information for a
 * BTC-only, uniform-param venue — cadence, expiry, time left, price, IV,
 * leverage, id — matched to legacy's density and interaction (sticky header,
 * glass shell, faded row dividers, pagination, GSAP row-entrance + click-flash).
 *
 * Price/IV come from the bounded per-page pricer poll (useV2Pricers); rows
 * without a live snapshot render '—', exactly like legacy.
 */
import { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { LuChevronLeft, LuChevronRight } from 'react-icons/lu';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { useNow } from '@/lib/hooks/use-now';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { useV2Pricers } from '@/lib/hooks/use-v2-pricers';
import { toFloat } from '@/config/scale';
import { impliedVol, timeToExpiryYears } from '@/lib/svi/svi';
import { price, dateUTC, countdown, pct, shortId } from '@/lib/format';
import {
  cadenceOf,
  CADENCE_LABEL,
  maxLeverageX,
  isClosingSoon,
  isTooCloseToExpiry,
} from '@/lib/markets/v2-discovery';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function V2MarketTable({
  markets,
  pricerSeeds,
  serverNow,
}: {
  markets: V2Market[];
  pricerSeeds: Record<string, LivePricer>;
  serverNow: number;
}) {
  const marketId = useV2TradeStore((s) => s.marketId);
  const select = useV2TradeStore((s) => s.selectMarket);
  // Opening the mobile ticket sheet on pick (desktop ignores it — the rail
  // ticket is always visible there). Mirrors legacy's pick → openTicketSheet.
  const openTicketSheet = useV2TradeStore((s) => s.openTicketSheet);
  const now = useNow(serverNow);

  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const pageSize = isDesktop ? 9 : 6;
  const [page, setPage] = useState(0);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  // Live, tradeable list: drop expired the moment the clock passes them.
  const visible = markets.filter((m) => m.expiry > now);
  const hiddenCount = markets.length - visible.length;

  // Clamp the page in render (no effect) so a shrinking list can't strand us
  // on an empty page.
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pageStart = safePage * pageSize;
  const pageRows = visible.slice(pageStart, pageStart + pageSize);

  // Only poll pricers for the rows actually on screen (bounded RPC).
  const pricers = useV2Pricers(
    pageRows.map((m) => m.expiry_market_id),
    pricerSeeds,
  );

  // Entrance choreography: rows rise + fade in with a tight stagger on first
  // paint (and each Cards↔Table switch, since this remounts). One intentional
  // moment — not idle hover wiggle. Mount-only.
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
  }, []);

  function flashRow(el: HTMLElement) {
    if (prefersReducedMotion()) return;
    gsap.fromTo(
      el,
      { backgroundColor: 'rgba(77, 214, 176, 0.22)' },
      { backgroundColor: 'rgba(77, 214, 176, 0)', duration: 0.6, ease: 'power2.out', clearProps: 'backgroundColor' },
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 className="flex items-center gap-2">
          <span className="eyebrow">Active markets</span>
          {visible.length > 0 && (
            <span className="rounded-full bg-bg-3 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-text-2">
              {visible.length}
            </span>
          )}
        </h2>
        <span className="font-mono text-[10px] text-text-3">
          {hiddenCount > 0 && <span>{hiddenCount} expired hidden · </span>}
          Tap a row to start a trade
        </span>
      </div>

      {visible.length === 0 ? (
        <div className="glass-card mt-3 flex min-h-48 flex-1 flex-col items-center justify-center gap-1 px-4 py-10 text-center">
          <span className="text-[12px] text-text-2">No active markets right now</span>
          <span className="text-[11px] text-text-3">Waiting for the next expiry to open.</span>
        </div>
      ) : (
        <div className="glass-card mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="scroll-quiet min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse font-mono text-[11px] tabular-nums sm:text-[12px]">
              <thead>
                <tr className="sticky top-0 z-10 text-left text-[10px] uppercase tracking-wider text-text-3 [&>th]:border-b [&>th]:border-line [&>th]:bg-[color-mix(in_srgb,var(--bg-1)_82%,transparent)] [&>th]:backdrop-blur-xl">
                  <Th>Market</Th>
                  <Th>Closes</Th>
                  <Th>Time left</Th>
                  <Th className="text-right">Price</Th>
                  <Th className="text-right">Volatility</Th>
                  <Th className="hidden text-right sm:table-cell">Leverage</Th>
                  <Th className="hidden text-right sm:table-cell">Step</Th>
                  <Th className="hidden text-right sm:table-cell">ID</Th>
                </tr>
              </thead>
              <tbody ref={bodyRef} className="row-divider">
                {pageRows.map((m) => {
                  const p = pricers[m.expiry_market_id];
                  const selected = marketId === m.expiry_market_id;
                  const tooClose = isTooCloseToExpiry(m, now);
                  const closingSoon = !tooClose && isClosingSoon(m, now);
                  const atmIv = p
                    ? impliedVol(p.forward, p.forward, p.svi, Math.max(timeToExpiryYears(m.expiry, now), 0))
                    : null;
                  const exp = dateUTC(m.expiry, false);
                  const expSplit = exp.lastIndexOf(' ');
                  const expDate = exp.slice(0, expSplit);
                  const expTime = exp.slice(expSplit + 1);
                  return (
                    <tr
                      key={m.expiry_market_id}
                      onClick={(e) => {
                        flashRow(e.currentTarget);
                        select(m.expiry_market_id);
                        openTicketSheet();
                      }}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          flashRow(e.currentTarget);
                          select(m.expiry_market_id);
                          openTicketSheet();
                        }
                      }}
                      aria-selected={selected}
                      className={[
                        'group cursor-pointer transition-colors hover:bg-white/[0.035] focus-visible:bg-white/5 focus-visible:outline-none',
                        selected ? 'bg-(--accent-soft)' : '',
                      ].join(' ')}
                    >
                      <Td className="text-text-1">
                        <span className="relative inline-flex items-center gap-2.5 pl-2.5">
                          <span
                            className={`absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full transition-colors ${
                              selected ? 'bg-accent' : 'bg-transparent'
                            }`}
                          />
                          <span className="font-medium">{CADENCE_LABEL[cadenceOf(m)]}</span>
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
                        {tooClose ? (
                          <span className="inline-block whitespace-nowrap rounded bg-(--down-soft) px-1.5 py-0.5 text-down">
                            {countdown(m.expiry, now)}
                          </span>
                        ) : closingSoon ? (
                          <span className="inline-block whitespace-nowrap rounded bg-(--warn-soft) px-1.5 py-0.5 text-warn">
                            {countdown(m.expiry, now)}
                          </span>
                        ) : (
                          <span className="whitespace-nowrap text-text-2">{countdown(m.expiry, now)}</span>
                        )}
                      </Td>
                      <Td className="text-right text-text-2">{p ? price(p.forward, 0) : '—'}</Td>
                      <Td className="text-right text-text-1">{atmIv != null ? pct(atmIv, 1) : '—'}</Td>
                      <Td className="hidden text-right text-text-3 sm:table-cell">{maxLeverageX(m)}x</Td>
                      <Td className="hidden text-right text-text-3 sm:table-cell">{price(toFloat(m.admission_tick_size), 0)}</Td>
                      <Td className="hidden text-right text-text-3 group-hover:text-text-2 sm:table-cell">
                        {shortId(m.expiry_market_id)}
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
                <PagerArrow dir="prev" disabled={safePage === 0} onClick={() => setPage(safePage - 1)} />
                <span className="px-1.5 font-mono text-[11px] tabular-nums text-text-2">
                  {safePage + 1}
                  <span className="text-text-3"> / {pageCount}</span>
                </span>
                <PagerArrow dir="next" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PagerArrow({ dir, disabled, onClick }: { dir: 'prev' | 'next'; disabled: boolean; onClick: () => void }) {
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
