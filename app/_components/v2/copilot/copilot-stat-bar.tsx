'use client';

/**
 * CopilotStatBar — the live market header docked above the surface on the
 * co-pilot page. Reclaims the dead band at the top of the stage and gives the
 * page a heartbeat: spot + move, then the same regime verdicts the co-pilot
 * quotes in chat (vol, arb, off-chain bias, Fear & Greed), then the next-expiry
 * countdown.
 *
 * It is a LEAF on purpose. The live-ticking bits — spot (useV2Spot) and the
 * countdown (useNow) — subscribe INSIDE here, so they re-render this thin strip
 * every tick and never the heavy surface beside it. Everything slower (the vol /
 * arb / bias verdicts) arrives as props the screen recomputes on its own cadence.
 * Pills self-hide when their input isn't ready (e.g. no candle history yet, or
 * Clawby gated off), so it degrades cleanly rather than guessing.
 */
import { LuTrendingUp, LuTrendingDown, LuClock } from 'react-icons/lu';
import { num } from '@/lib/format';
import { useV2Spot } from '@/lib/hooks/use-v2-spot';
import { useNow } from '@/lib/hooks/use-now';
import type { BtcInsights } from '@/lib/hooks/use-btc-insights';
import type { VolState, ArbState, Bias } from '@/lib/copilot/pulse';

type Tone = 'up' | 'down' | 'warn' | 'muted';

const TONE_CLASS: Record<Tone, string> = {
  up: 'text-up',
  down: 'text-down',
  warn: 'text-warn',
  muted: 'text-text-2',
};

/** Digital countdown: `6:47`, `0:52`, or `1:02:33` for longer-dated markets. */
function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function Pill({ label, value, tone = 'muted' }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="glass-inset flex items-center gap-2 rounded-lg px-2.5 py-1.5">
      <span className="text-[8.5px] uppercase tracking-wider text-text-3">{label}</span>
      <span className={`text-[11.5px] font-medium ${TONE_CLASS[tone]}`}>{value}</span>
    </div>
  );
}

export function CopilotStatBar({
  insights,
  vol,
  arb,
  bias,
  nextExpiry,
  serverNow,
}: {
  insights: BtcInsights | null;
  vol: VolState | null;
  arb: ArbState | null;
  bias: Bias | null;
  nextExpiry: number | null;
  serverNow: number;
}) {
  const spot = useV2Spot(); // live BTC (shared query — no extra fetch)
  const now = useNow(serverNow); // 1s tick, isolated to this strip

  const change = insights?.change24hPct ?? null;
  const chgUp = (change ?? 0) >= 0;

  const volLabel = vol === 'elevated' ? 'Elevated' : vol === 'calm' ? 'Calm' : 'Normal';
  const volTone: Tone = vol === 'elevated' ? 'warn' : vol === 'calm' ? 'up' : 'muted';

  const biasText = bias
    ? `${bias.confidence === 'clear' ? 'Clear' : 'Slight'} ${bias.pick === 'range' ? 'RANGE' : bias.pick.toUpperCase()}`
    : null;
  const biasTone: Tone = bias?.pick === 'down' ? 'down' : bias?.pick === 'up' ? 'up' : 'muted';

  const countdown = nextExpiry != null ? nextExpiry - now : null;

  return (
    <div className="relative flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-gradient-to-b from-white/[0.025] to-transparent px-4 py-2.5">
      {/* Spot + 24h move */}
      <div className="flex items-baseline gap-2.5">
        <span className="text-[9.5px] uppercase tracking-wider text-text-3">BTC</span>
        <span className="font-mono text-[19px] font-semibold tabular-nums tracking-tight text-text-1">
          {spot != null ? `$${num(spot, 0)}` : '—'}
        </span>
        {change != null && (
          <span className={`inline-flex items-center gap-1 font-mono text-[12px] tabular-nums ${chgUp ? 'text-up' : 'text-down'}`}>
            {chgUp ? <LuTrendingUp size={12} /> : <LuTrendingDown size={12} />}
            {chgUp ? '+' : ''}
            {num(change, 2)}%
            <span className="text-text-3">24h</span>
          </span>
        )}
      </div>

      {/* Regime verdicts — each self-hides when its input isn't ready. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {vol && <Pill label="Vol" value={volLabel} tone={volTone} />}
        {arb && <Pill label="Arb" value={arb === 'clean' ? 'Clean' : 'Watch'} tone={arb === 'clean' ? 'up' : 'warn'} />}
        {biasText && <Pill label="Bias" value={biasText} tone={biasTone} />}
        {insights?.sentiment && <Pill label="Fear · Greed" value={`${insights.sentiment.value} ${insights.sentiment.label}`} tone="muted" />}
      </div>

      {/* Next expiry countdown + live marker */}
      <div className="ml-auto flex items-center gap-3">
        {countdown != null && countdown > 0 && (
          <span className="inline-flex items-center gap-1.5 font-mono text-[11.5px] tabular-nums text-text-2">
            <LuClock size={11} className="text-text-3" />
            {fmtCountdown(countdown)}
            <span className="text-[8.5px] uppercase tracking-wider text-text-3">next</span>
          </span>
        )}
        <span className="text-[9px] uppercase tracking-[0.16em] text-accent">Live</span>
      </div>
    </div>
  );
}
