'use client';

/**
 * V2FlowTape — the live bet feed, in the legacy LiveTicker/FlowTape language:
 * a glass-card with a head-divider, then rows-divided entries (direction chip ·
 * avatar · short id · market · staked · age). The global trade feed isn't
 * indexed yet, so this runs on SAMPLE data — seeded from server rows (stable
 * hydration) then a fresh sample bet flashes in every few seconds. Swap
 * `makeFlowRow` for the real `/positions/minted` stream when it ships.
 */
import { useEffect, useRef, useState } from 'react';
import { LuArrowUp, LuArrowDown, LuArrowLeftRight } from 'react-icons/lu';
import { CADENCE_LABEL } from '@/lib/markets/v2-discovery';
import { makeFlowRow, makeRng, type DemoFlowRow } from '@/lib/api/v2/analytics-demo';
import { num, ago, shortId } from '@/lib/format';
import { WalletAvatar } from '@/app/_components/leaderboard/wallet-avatar';
import { SampleBadge } from './sample-badge';

export function V2FlowTape({
  initial,
  limit,
  title = 'Live bets',
  live = true,
}: {
  initial: DemoFlowRow[];
  /** Cap the visible rows (Pulse ticker passes a small number). */
  limit?: number;
  title?: string;
  live?: boolean;
}) {
  const [rows, setRows] = useState<DemoFlowRow[]>(initial);
  const [now, setNow] = useState<number>(() => initial[0]?.tsMs ?? Date.now());
  const rng = useRef(makeRng());
  const cap = limit ?? 40;

  useEffect(() => {
    if (!live) return;
    let alive = true;
    const clock = setInterval(() => alive && setNow(Date.now()), 1000);
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          if (!alive) return;
          setRows((prev) => [makeFlowRow(rng.current, Date.now(), 0), ...prev].slice(0, cap));
          schedule();
        },
        2000 + Math.random() * 3200,
      );
    };
    schedule();
    return () => {
      alive = false;
      clearInterval(clock);
      clearTimeout(timer);
    };
  }, [live, cap]);

  const visible = limit ? rows.slice(0, limit) : rows;

  return (
    <div className="glass-card flex flex-col overflow-hidden">
      <div className="head-divider flex items-center gap-2 px-4 py-3">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
        </span>
        <span className="text-[13px] font-semibold tracking-tight text-text-1">{title}</span>
        <span className="ml-auto">
          <SampleBadge />
        </span>
      </div>
      <div className="rows-divided flex-1">
        {visible.map((r) => (
          <FlowRow key={r.id} row={r} now={now} />
        ))}
      </div>
    </div>
  );
}

function FlowRow({ row, now }: { row: DemoFlowRow; now: number }) {
  const isUp = row.side === 'up';
  const isRange = row.side === 'range';
  const Icon = isRange ? LuArrowLeftRight : isUp ? LuArrowUp : LuArrowDown;
  const chip = isRange ? 'bg-accent' : isUp ? 'bg-up' : 'bg-down';

  return (
    <div className="flash-in flex items-center gap-2.5 px-4 py-2">
      <span className={`inline-flex h-5 w-5 flex-none items-center justify-center rounded-md ${chip} text-bg-0`}>
        <Icon size={11} />
      </span>
      <WalletAvatar addr={row.trader} size={16} ring="rgba(255,255,255,0.10)" />
      <span className="truncate font-mono text-[11px] text-text-2">{shortId(row.trader)}</span>
      <span className="ml-auto flex-none font-mono text-[10px] text-text-3">
        BTC · {CADENCE_LABEL[row.cadence]}
        {row.leverage > 1 && <span className="ml-1 text-text-2">{row.leverage}×</span>}
      </span>
      <span className="flex-none font-mono text-[11px] tabular-nums text-text-1">${num(row.stakeUsd, 2)}</span>
      <span className="w-7 flex-none text-right font-mono text-[10px] tabular-nums text-text-3">{ago(row.tsMs, now)}</span>
    </div>
  );
}
