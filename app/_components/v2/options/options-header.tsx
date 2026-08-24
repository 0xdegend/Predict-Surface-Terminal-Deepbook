'use client';

/**
 * OptionsHeader — the page's top strip: asset + live price, the market-regime
 * pills (jumpiness / arb / lean / sentiment), the next-expiry countdown, and the
 * Plain/Pro toggle. A leaf that owns its OWN ticking (useNow + a cache read of the
 * live spot), so the live price and countdown update without re-rendering the
 * heavy surface above it.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useNow } from '@/lib/hooks/use-now';
import { useMounted } from '@/lib/hooks/use-mounted';
import { pythSpot, qkV2 } from '@/lib/api/v2/client';
import { num, signed } from '@/lib/format';
import { VocabToggle, useVocab } from './vocab';
import { expiryLabel } from '@/lib/insights';
import type { PythObservation } from '@/lib/api/v2/types';
import type { MarketIntel } from '@/lib/insights';
import type { BtcInsights } from '@/lib/hooks/use-btc-insights';

const VOL_LABEL = { calm: 'Calm', normal: 'Normal', elevated: 'Jumpy' } as const;

function countdown(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function OptionsHeader({ intel, insights, serverNow }: { intel: MarketIntel; insights: BtcInsights | null; serverNow: number }) {
  const now = useNow(serverNow);
  const { pro } = useVocab();
  const mounted = useMounted();
  const qc = useQueryClient();
  // Read the live spot imperatively from the tape cache, but only after mount so
  // SSR and the first client render agree ("—") and it switches on after hydration
  // (no hydration mismatch). Same rule for the 24h change and the sentiment pill.
  const obs = mounted ? qc.getQueryData<PythObservation | null>(qkV2.pythLatest) ?? null : null;
  const spot = mounted ? pythSpot(obs) ?? intel.spot : null;
  const chg = mounted ? insights?.change24hPct ?? null : null;

  return (
    <header className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line pb-3">
      {/* On a phone the title owns the whole first row and takes the Plain/Pro toggle
          with it: the toggle is the one control that changes what the page IS, so it
          should not end up alone on a third line of chrome under the price and the
          pills. From sm up the title shrinks back and the toggle rejoins the right
          cluster where it has always lived. */}
      <div className="flex w-full items-center gap-2 sm:w-auto">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-linear-to-br from-[#f7931a] to-[#ffb64d] text-[12px] font-bold text-black">₿</span>
        <span className="text-[15px] font-semibold text-text-1">{intel.asset.label} Options</span>
        <span className="ml-auto sm:hidden">
          <VocabToggle />
        </span>
      </div>

      {/* Live price + 24h change: widths reserved so the row holds its shape while
          the numbers load (no shrink, no shift — §10.7). */}
      <div className="flex items-baseline gap-2 font-mono">
        <span className="inline-block min-w-[7ch] text-[16px] tabular-nums text-text-1">{spot != null ? `$${num(spot, 0)}` : '—'}</span>
        <span className={`inline-block min-w-14 text-[12px] tabular-nums ${chg == null ? 'text-text-3' : chg >= 0 ? 'text-up' : 'text-down'}`}>
          {chg != null ? `${signed(chg, 2)}%` : ''}
        </span>
      </div>

      {/* Regime pills — each slot reserves its space with a placeholder until its
          datum arrives, so the cluster doesn't pop in and reflow the row. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {/* Pro only. "Calm" / "Jumpy" with no legend is a word a newcomer cannot act
            on, and the Surface read headline right below already says the same thing in
            a sentence. A desk reads the regime at a glance, so it stays in Pro. */}
        {pro &&
          (intel.vol ? (
            <Pill tone={intel.vol === 'elevated' ? 'down' : intel.vol === 'calm' ? 'up' : 'neutral'} label={VOL_LABEL[intel.vol]} />
          ) : (
            <PillSkel className="w-13" />
          ))}
        {/* Pro only: "Arb-free" is a verdict about the surface's internal consistency —
            real information to a desk, noise to someone deciding their first bet. */}
        {pro &&
          (intel.arb ? (
            <Pill tone={intel.arb === 'watch' ? 'down' : 'up'} label={intel.arb === 'watch' ? 'Mispricing' : 'Arb-free'} />
          ) : (
            <PillSkel className="w-17.5" />
          ))}
        {intel.bias ? (
          <Pill
            tone={intel.bias.pick === 'down' ? 'down' : intel.bias.pick === 'up' ? 'up' : 'neutral'}
            label={intel.bias.pick === 'range' ? 'No clear lean' : `Leaning ${intel.bias.pick}`}
          />
        ) : (
          <PillSkel className="w-23" />
        )}
        {/* The 0-100 sentiment score used to sit here, Pro only. It was the least
            desk-relevant number in the header — a score that needs its own legend to
            mean anything, in the row a trader reads fastest — and it is already
            carried twice over: in the Surface read's sentiment line and in the
            Positioning deck. The header now holds only figures that price a bet. */}
      </div>

      <div className="ml-auto flex items-center gap-3">
        {/* Pro: the one number a desk reads first, which the page never showed anywhere —
            at-the-money implied vol on the front expiry, and how the term structure
            slopes from there to the back. */}
        {pro && <AtmIvReadout intel={intel} now={now} />}
        {/* The expiry pills right below the hero carry the same countdown on a phone, so
            this line stands down there rather than pushing the row taller. */}
        {intel.nextExpiryMs != null && (
          <span className="hidden font-mono text-[12px] text-text-2 sm:inline">
            next expiry <span className="inline-block min-w-13 text-right tabular-nums text-text-1">{countdown(intel.nextExpiryMs - now)}</span>
          </span>
        )}
        <span className="hidden sm:block">
          <VocabToggle />
        </span>
      </div>
    </header>
  );
}

/**
 * ATM implied vol on the front expiry, plus the term-structure slope to the back one.
 * Slope is back − front in vol points: positive means the market is pricing MORE
 * movement further out (the normal shape), negative means the front is bid — the stress
 * signature worth seeing before anything else.
 */
function AtmIvReadout({ intel, now }: { intel: MarketIntel; now: number }) {
  const rows = intel.expiries;
  if (rows.length === 0) return null;
  const front = rows[0];
  const back = rows.length > 1 ? rows[rows.length - 1] : null;
  const slope = back ? (back.iv - front.iv) * 100 : null;
  return (
    <span className="font-mono text-[12px] text-text-2" title="At-the-money implied vol, front expiry → back expiry">
      ATM IV <span className="tabular-nums text-text-1">{(front.iv * 100).toFixed(1)}%</span>
      {back && (
        <>
          {' → '}
          <span className="tabular-nums text-text-1">{(back.iv * 100).toFixed(1)}%</span>
          <span className="text-text-3"> {expiryLabel(back.expiryMs, now)}</span>{' '}
          <span className={`tabular-nums ${slope! >= 0 ? 'text-up' : 'text-down'}`}>{signed(slope!, 1)}</span>
        </>
      )}
    </span>
  );
}

/** A faint fixed-width chip that reserves a regime pill's space until its datum
 *  loads, so the header keeps its shape while data streams in (no shrink / shift). */
function PillSkel({ className = '' }: { className?: string }) {
  return <span aria-hidden className={`h-5 rounded-full bg-white/5 ring-1 ring-inset ring-line ${className}`} />;
}

function Pill({ label, tone }: { label: string; tone: 'up' | 'down' | 'neutral' }) {
  const cls =
    tone === 'up'
      ? 'bg-(--accent-soft) text-accent ring-(--accent-line)'
      : tone === 'down'
        ? 'bg-down/10 text-down ring-down/30'
        : 'bg-white/5 text-text-2 ring-line';
  return <span className={`rounded-full px-2 py-0.5 text-[11px] ring-1 ring-inset ${cls}`}>{label}</span>;
}
