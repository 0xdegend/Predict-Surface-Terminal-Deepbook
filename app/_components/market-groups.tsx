'use client';

/**
 * Market cards — the beginner-friendly alternative to the oracle table. Same
 * data, same control wiring (clicking selects the oracle on the 3-D surface and
 * pre-fills the trade ticket), but presented as grouped cards that lead with the
 * decision — "will BTC be UP or DOWN by this time" — instead of SVI plumbing.
 *
 * Each card is one oracle, priced at the at-the-money strike. UP/DOWN buttons
 * select that side; the real (chain-authoritative) quote still happens in the
 * ticket. Cards are grouped by cadence (15-minute / hourly / daily) — see
 * `lib/markets/grouping`.
 */
import { useMemo, useState } from 'react';
import {
  LuTimer,
  LuClock3,
  LuClock,
  LuCalendarDays,
  LuCalendarRange,
  LuTrendingUp,
  LuTrendingDown,
  LuChevronLeft,
  LuChevronRight,
} from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { useSurfaceStore } from '@/lib/store/surface-store';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { useNow } from '@/lib/hooks/use-now';
import { useLiveOracleData } from '@/lib/hooks/use-live-oracle-data';
import { snapStrikeToTick } from '@/lib/keys';
import { toFloat } from '@/config/scale';
import { impliedVol, timeToExpiryYears } from '@/lib/svi/svi';
import { price, pct, countdown, dateUTC } from '@/lib/format';
import { groupOracles, cadenceOf, CADENCE_TAG, type Horizon } from '@/lib/markets/grouping';
import type { SmileInput } from '@/lib/svi/surface';
import type { Oracle } from '@/lib/api/types';

/** Markets inside this window are about to settle — minting may revert. */
const CLOSING_SOON_MS = 120_000;
const URGENT_MS = 15 * 60_000;

const HORIZON_ICON: Record<Horizon, IconType> = {
  closing: LuTimer,
  hour: LuClock3,
  hours: LuClock,
  days: LuCalendarDays,
  weeks: LuCalendarRange,
};

export function MarketGroups({
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
  // Shared poll with the table/ticket — newly opened expiries appear, settled
  // ones drop, no reload.
  const { oracles, inputs } = useLiveOracleData(initialOracles, initialInputs);

  const inputById = useMemo(() => {
    const m = new Map<string, SmileInput>();
    for (const i of inputs) m.set(i.oracle.oracle_id, i);
    return m;
  }, [inputs]);

  const groups = useMemo(() => groupOracles(oracles, now), [oracles, now]);

  function pick(input: SmileInput, isUp: boolean) {
    const { oracle, forward } = input;
    // At-the-money: snap the live forward to the nearest tradeable grid strike.
    const strikeScaled = snapStrikeToTick(BigInt(Math.round(forward * 1e9)), oracle);
    select({
      oracleId: oracle.oracle_id,
      expiry: oracle.expiry,
      strikeScaled: strikeScaled.toString(),
      strike: toFloat(Number(strikeScaled)),
      isUp,
    });
    if (typeof document !== 'undefined') {
      document.getElementById('trade-ticket')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  const total = groups.reduce((n, g) => n + g.oracles.length, 0);

  // Paginate the whole card list so it never runs the page on forever — fewer
  // cards on a phone, a fuller page on desktop (mirrors the table's pager).
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const pageSize = isDesktop ? 8 : 4;
  const [page, setPage] = useState(0);

  // Flatten in group order so we can slice across groups, keeping each card's
  // cadence so the page can re-group only what it shows.
  const flat = useMemo(
    () =>
      groups.flatMap((g) =>
        g.oracles.map((oracle) => ({ oracle, horizon: g.horizon, meta: g.meta })),
      ),
    [groups],
  );
  // True size of each cadence group, so a header badge stays accurate even when
  // the group is split across pages.
  const groupTotals = useMemo(
    () => new Map(groups.map((g) => [g.horizon, g.oracles.length])),
    [groups],
  );

  // Clamp the page in render (no effect) so a shrinking list — expiries dropping
  // each second, or the page size halving on a viewport change — can't strand us
  // on an empty page.
  const pageCount = Math.max(1, Math.ceil(flat.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pageStart = safePage * pageSize;
  const pageItems = flat.slice(pageStart, pageStart + pageSize);

  // Re-group consecutive page items by cadence (flat is already in group order).
  const pageGroups: { horizon: Horizon; meta: (typeof groups)[number]['meta']; oracles: Oracle[] }[] = [];
  for (const it of pageItems) {
    const last = pageGroups[pageGroups.length - 1];
    if (last && last.horizon === it.horizon) last.oracles.push(it.oracle);
    else pageGroups.push({ horizon: it.horizon, meta: it.meta, oracles: [it.oracle] });
  }

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h2 className="flex items-center gap-2">
          <span className="eyebrow">Markets</span>
          {total > 0 && (
            <span className="rounded-full bg-bg-3 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-text-2">
              {total}
            </span>
          )}
        </h2>
        <span className="font-mono text-[10px] text-text-3">pick a side → loads the ticket</span>
      </div>

      {total === 0 ? (
        <div className="card mt-3 flex flex-col items-center gap-1 px-4 py-10 text-center">
          <span className="text-[12px] text-text-2">No active markets right now</span>
          <span className="text-[11px] text-text-3">Waiting for the next expiry to open.</span>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-6">
          {pageGroups.map((g) => {
            const Icon = HORIZON_ICON[g.horizon];
            return (
              <section key={g.horizon}>
                <div className="mb-2.5 flex items-start gap-2.5">
                  <span className="mt-0.5 flex-none text-text-2">
                    <Icon size={15} />
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[12px] font-medium text-text-1">{g.meta.label}</h3>
                      <span className="rounded-full bg-bg-3 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-text-2">
                        {groupTotals.get(g.horizon) ?? g.oracles.length}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-snug text-text-3">{g.meta.blurb}</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {g.oracles.map((o) => (
                    <MarketCard
                      key={o.oracle_id}
                      oracle={o}
                      input={inputById.get(o.oracle_id)}
                      now={now}
                      tag={CADENCE_TAG[cadenceOf(o)]}
                      selection={selection}
                      onPick={pick}
                    />
                  ))}
                </div>
              </section>
            );
          })}

          {pageCount > 1 && (
            <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
              <span className="font-mono text-[10px] tabular-nums text-text-3">
                {pageStart + 1}–{pageStart + pageItems.length} of {flat.length}
              </span>
              <div className="flex items-center gap-1">
                <PagerArrow dir="prev" disabled={safePage === 0} onClick={() => setPage(safePage - 1)} />
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

function MarketCard({
  oracle,
  input,
  now,
  tag,
  selection,
  onPick,
}: {
  oracle: Oracle;
  input: SmileInput | undefined;
  now: number;
  tag: string;
  selection: ReturnType<typeof useSurfaceStore.getState>['selection'];
  onPick: (input: SmileInput, isUp: boolean) => void;
}) {
  const msLeft = oracle.expiry - now;
  const closingSoon = msLeft < CLOSING_SOON_MS;
  const urgent = !closingSoon && msLeft < URGENT_MS;
  const pickable = !!input;

  const atmIv =
    input != null
      ? impliedVol(
          input.forward,
          input.forward,
          input.svi,
          Math.max(timeToExpiryYears(oracle.expiry, now), 0),
        )
      : null;

  const isSelected = selection?.oracleId === oracle.oracle_id;
  const upSelected = isSelected && selection?.isUp === true;
  const downSelected = isSelected && selection?.isUp === false;

  return (
    <div
      className={[
        'card interactive flex flex-col gap-3 p-3',
        isSelected ? 'border-line-strong' : '',
        pickable ? '' : 'opacity-40',
      ].join(' ')}
      aria-disabled={!pickable}
    >
      {/* Header: underlying + cadence tag, live countdown */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[13px] font-medium text-text-1">{oracle.underlying_asset}</span>
          <span className="rounded bg-bg-3 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-text-3">
            {tag}
          </span>
        </div>
        <span
          className={[
            'rounded px-1.5 py-0.5 font-mono text-[11px] tabular-nums',
            closingSoon
              ? 'bg-[var(--down-soft)] text-down'
              : urgent
                ? 'bg-[var(--warn-soft)] text-warn'
                : 'text-text-2',
          ].join(' ')}
        >
          {countdown(oracle.expiry, now)}
        </span>
      </div>

      {/* Reference price the market is trading around */}
      <div className="flex items-end justify-between gap-2">
        <div className="flex flex-col">
          <span className="eyebrow">Price now</span>
          <span className="font-mono text-[20px] leading-tight tabular-nums text-text-1">
            {input ? price(input.forward, 0) : '—'}
          </span>
        </div>
        <div className="flex flex-col items-end gap-0.5 text-right">
          <span className="font-mono text-[11px] tabular-nums text-text-2">
            {atmIv != null ? `${pct(atmIv, 1)} IV` : '—'}
          </span>
          <span className="font-mono text-[10px] tabular-nums text-text-3">{dateUTC(oracle.expiry)}</span>
        </div>
      </div>

      {/* Decision: pick a side. Loads the ticket at the at-the-money strike. */}
      <div className="grid grid-cols-2 gap-2">
        <SideButton
          icon={LuTrendingUp}
          label="Up"
          tone="up"
          selected={upSelected}
          disabled={!pickable}
          onClick={() => input && onPick(input, true)}
        />
        <SideButton
          icon={LuTrendingDown}
          label="Down"
          tone="down"
          selected={downSelected}
          disabled={!pickable}
          onClick={() => input && onPick(input, false)}
        />
      </div>
    </div>
  );
}

function SideButton({
  icon: Icon,
  label,
  tone,
  selected,
  disabled,
  onClick,
}: {
  icon: IconType;
  label: string;
  tone: 'up' | 'down';
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const base =
    'flex items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50';
  const tones =
    tone === 'up'
      ? selected
        ? 'border-up/50 bg-up/15 text-up'
        : 'border-line-soft text-up hover:border-up/40 hover:bg-up/10'
      : selected
        ? 'border-down/50 bg-down/15 text-down'
        : 'border-line-soft text-down hover:border-down/40 hover:bg-down/10';
  const ring = tone === 'up' ? 'focus-visible:ring-up/40' : 'focus-visible:ring-down/40';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={`${base} ${tones} ${ring}`}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}
