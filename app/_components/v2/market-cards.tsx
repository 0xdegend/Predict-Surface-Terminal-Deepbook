'use client';

/**
 * V2MarketCards — the beginner-friendly card view of active markets (legacy
 * MarketGroups' role). Same data and wiring as the table, but led by the
 * decision — "will BTC be Up or Down by this time" — with a live countdown,
 * price, and ATM IV per card. Grouped by cadence. Picking a side selects the
 * market AND the direction into the shared store; the strike/stake are chosen
 * in the ticket.
 *
 * Price/IV come from a bounded pricer poll over the visible markets (seeded for
 * instant paint); cards without a snapshot show '—', like legacy.
 */
import { LuTrendingUp, LuTrendingDown } from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { useNow } from '@/lib/hooks/use-now';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { useV2Pricers } from '@/lib/hooks/use-v2-pricers';
import { impliedVol, timeToExpiryYears } from '@/lib/svi/svi';
import { price, pct, countdown, dateUTC } from '@/lib/format';
import {
  groupByCadence,
  CADENCE_ORDER,
  CADENCE_LABEL,
  usableMaxLeverageX,
  isClosingSoon,
  isTooCloseToExpiry,
} from '@/lib/markets/v2-discovery';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

export function V2MarketCards({
  markets,
  pricerSeeds,
  serverNow,
}: {
  markets: V2Market[];
  pricerSeeds: Record<string, LivePricer>;
  serverNow: number;
}) {
  const now = useNow(serverNow);
  const marketId = useV2TradeStore((s) => s.marketId);
  const isUp = useV2TradeStore((s) => s.isUp);
  const select = useV2TradeStore((s) => s.selectMarket);
  const setIsUp = useV2TradeStore((s) => s.setIsUp);
  const markPicked = useV2TradeStore((s) => s.markPicked);
  const openTicketSheet = useV2TradeStore((s) => s.openTicketSheet);

  const visible = markets.filter((m) => m.expiry > now);
  const grouped = groupByCadence(visible);
  const pricers = useV2Pricers(
    visible.map((m) => m.expiry_market_id),
    pricerSeeds,
  );

  function pick(m: V2Market, up: boolean) {
    select(m.expiry_market_id);
    setIsUp(up);
    // A card pick chooses market + side in one tap — advance the ticket to
    // its bet step (legacy parity).
    markPicked();
    // Bring the ticket to the user on mobile (desktop ignores it).
    openTicketSheet();
  }

  if (visible.length === 0) {
    return (
      <div className="card mt-3 flex flex-col items-center gap-1 px-4 py-10 text-center">
        <span className="text-[12px] text-text-2">No active markets right now</span>
        <span className="text-[11px] text-text-3">Waiting for the next expiry to open.</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {CADENCE_ORDER.map((c) =>
        grouped[c].length ? (
          <section key={c}>
            <div className="mb-2.5 flex items-center gap-2">
              <h3 className="text-[12px] font-medium text-text-1">{CADENCE_LABEL[c]} markets</h3>
              <span className="rounded-full bg-bg-3 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-text-2">
                {grouped[c].length}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {grouped[c].map((m) => (
                <Card
                  key={m.expiry_market_id}
                  market={m}
                  pricer={pricers[m.expiry_market_id]}
                  now={now}
                  selectedUp={marketId === m.expiry_market_id && isUp}
                  selectedDown={marketId === m.expiry_market_id && !isUp}
                  onPick={pick}
                />
              ))}
            </div>
          </section>
        ) : null,
      )}
    </div>
  );
}

function Card({
  market,
  pricer,
  now,
  selectedUp,
  selectedDown,
  onPick,
}: {
  market: V2Market;
  pricer: LivePricer | undefined;
  now: number;
  selectedUp: boolean;
  selectedDown: boolean;
  onPick: (m: V2Market, up: boolean) => void;
}) {
  const tooClose = isTooCloseToExpiry(market, now);
  const closingSoon = !tooClose && isClosingSoon(market, now);
  const isSelected = selectedUp || selectedDown;
  const atmIv = pricer
    ? impliedVol(pricer.forward, pricer.forward, pricer.svi, Math.max(timeToExpiryYears(market.expiry, now), 0))
    : null;

  return (
    <div className={`card interactive flex flex-col gap-3 p-3 ${isSelected ? 'border-line-strong' : ''}`}>
      {/* header: cadence tag + live countdown */}
      <div className="flex items-center justify-between">
        <span className="rounded bg-bg-3 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-text-3">
          {/* "up to Nx" only reads right when leverage is actually available; inside the
              no-leverage window it's a flat 1x, so drop the "up to". */}
          {usableMaxLeverageX(market, now) > 1 ? `up to ${usableMaxLeverageX(market, now)}x` : '1x'}
        </span>
        <span
          className={[
            'rounded px-1.5 py-0.5 font-mono text-[11px] tabular-nums',
            tooClose ? 'bg-(--down-soft) text-down' : closingSoon ? 'bg-(--warn-soft) text-warn' : 'text-text-2',
          ].join(' ')}
        >
          {countdown(market.expiry, now)}
        </span>
      </div>

      {/* reference price + IV */}
      <div className="flex items-end justify-between gap-2">
        <div className="flex flex-col">
          <span className="eyebrow">Price now</span>
          <span className="font-mono text-[20px] leading-tight tabular-nums text-text-1">
            {pricer ? price(pricer.forward, 0) : '—'}
          </span>
        </div>
        <div className="flex flex-col items-end gap-0.5 text-right">
          <span className="font-mono text-[11px] tabular-nums text-text-2">{atmIv != null ? `${pct(atmIv, 1)} IV` : '—'}</span>
          <span className="font-mono text-[10px] tabular-nums text-text-3">{dateUTC(market.expiry)}</span>
        </div>
      </div>

      {/* decision: pick a side (loads the ticket at ATM) */}
      <div className="grid grid-cols-2 gap-2">
        <SideButton icon={LuTrendingUp} label="Up" tone="up" selected={selectedUp} onClick={() => onPick(market, true)} />
        <SideButton icon={LuTrendingDown} label="Down" tone="down" selected={selectedDown} onClick={() => onPick(market, false)} />
      </div>
    </div>
  );
}

function SideButton({
  icon: Icon,
  label,
  tone,
  selected,
  onClick,
}: {
  icon: IconType;
  label: string;
  tone: 'up' | 'down';
  selected: boolean;
  onClick: () => void;
}) {
  const base =
    'flex items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2';
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
    <button type="button" onClick={onClick} aria-pressed={selected} className={`${base} ${tones} ${ring}`}>
      <Icon size={14} />
      {label}
    </button>
  );
}
