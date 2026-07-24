'use client';

/**
 * CopilotRead — the ambient "surface read" card pinned at the top of the chat,
 * so the panel is alive before anyone types. It says, in one plain line, which
 * way the wider market leans and whether vol is running hot or calm, plus a small
 * spot sparkline. Every word comes from the SAME functions the conversation uses
 * (recommendation + the vol verdict), so it can never contradict the chat.
 *
 * Prop-driven and slow-moving: it re-renders on the screen's own pricer / insights
 * cadence, so it needs no live subscription of its own. It renders nothing until
 * there's something to say (no lean and no vol read), keeping the greeting clean.
 */
import { pct } from '@/lib/format';
import type { VolState, Bias } from '@/lib/copilot/pulse';

/** A tiny sparkline of the recent spot path, with an emphasized endpoint. */
function Sparkline({ closes }: { closes: number[] }) {
  const pts = closes.slice(-40);
  if (pts.length < 4) return null;
  const w = 66;
  const h = 20;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const x = (i: number) => (i / (pts.length - 1)) * w;
  const y = (v: number) => h - 2 - ((v - min) / span) * (h - 4);
  const d = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const up = pts[pts.length - 1] >= pts[0];
  const stroke = up ? 'var(--up)' : 'var(--down)';
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none" aria-hidden>
      <path d={d} stroke={stroke} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x(pts.length - 1)} cy={y(pts[pts.length - 1])} r="2" fill={stroke} />
    </svg>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-line bg-white/[0.02] px-2 py-1 font-mono text-[10px]">
      <span className="text-text-3">{label}</span>
      <span className={tone}>{value}</span>
    </span>
  );
}

export function CopilotRead({
  bias,
  vol,
  upChance,
  closes,
}: {
  bias: Bias | null;
  vol: VolState | null;
  /** Soonest market's chance-up read, for the mini stat (0..1). */
  upChance: number | null;
  closes: number[] | null;
}) {
  if (!bias && !vol) return null;

  const leanText = bias
    ? `The wider market leans ${bias.confidence === 'clear' ? 'clearly' : 'slightly'} ${bias.pick === 'range' ? 'to a range' : bias.pick === 'up' ? 'up' : 'down'}.`
    : 'No strong lean either way right now.';
  const volText =
    vol === 'elevated'
      ? 'Vol is running hot, so expect bigger swings and richer payouts.'
      : vol === 'calm'
        ? 'Vol is calm, so moves look quiet and safer bets cost less.'
        : vol === 'normal'
          ? 'Vol is about normal for BTC lately.'
          : '';

  const leanTone = bias?.pick === 'down' ? 'text-down' : bias?.pick === 'up' ? 'text-up' : 'text-text-2';
  const leanStat = bias ? `${bias.confidence === 'clear' ? 'Clear' : 'Slight'} ${bias.pick.toUpperCase()}` : 'Balanced';
  const volTone = vol === 'elevated' ? 'text-warn' : vol === 'calm' ? 'text-up' : 'text-text-2';

  return (
    <div className="glass-inset mx-4 mt-3 rounded-xl p-3">
      <div className="flex items-center justify-between">
        <span className="text-[8.5px] uppercase tracking-[0.16em] text-accent">Surface read · live</span>
        {closes && closes.length >= 4 && <Sparkline closes={closes} />}
      </div>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-text-2">
        {leanText}
        {volText ? ` ${volText}` : ''}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Stat label="Lean" value={leanStat} tone={leanTone} />
        {vol && <Stat label="Vol" value={vol === 'elevated' ? 'Elevated' : vol === 'calm' ? 'Calm' : 'Normal'} tone={volTone} />}
        {upChance != null && <Stat label="Up" value={pct(upChance, 0)} tone="text-text-1" />}
      </div>
    </div>
  );
}
