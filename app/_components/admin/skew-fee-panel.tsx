'use client';

/**
 * SkewFeePanel — the Skew fee (a % of each bet, on top of the live builder fee).
 *
 * Two modes, driven by whether our `skew_fee_v2` router is published for this network:
 *  - LIVE (router published): the fee is really charged on-chain. The rate + treasury are
 *    read from the on-chain `FeeConfig`; the admin edits a draft and commits it with one tx
 *    (`set_fee_bps`, gated on the AdminCap). The projection table then shows what that live
 *    rate earns against real attributed volume.
 *  - PROJECTION (not published): the old modelling mode — a local rate drives a
 *    what-would-it-earn projection, nothing is charged.
 *
 * Volume comes from the SAME `/api/v2/builder-fee-accrual` walk the fee chart uses (stake of
 * every attributed bet), so no new server load and the query key dedupes.
 */
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LuPercent, LuTrendingUp, LuInfo, LuRotateCcw, LuShieldCheck, LuCheck } from 'react-icons/lu';
import { predictV2Config } from '@/config/predict';
import { useSkewFeeRate, DEFAULT_SKEW_FEE_BPS } from '@/lib/hooks/use-skew-fee-rate';
import { useSkewFeeV2, useSkewFeeV2AdminCap, qkSkewFeeV2 } from '@/lib/hooks/use-skew-fee-v2';
import { buildSetSkewFeeBpsTx, SKEW_FEE_MAX_BPS } from '@/lib/sui/v2/skew-fee';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useBuilderFeeSummary } from '@/lib/hooks/use-builder-code';
import { useNow } from '@/lib/hooks/use-now';

interface AccrualEvent {
  ts: number;
  fee: number;
  stake: number;
}

const DAY = 86_400_000;
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usd0 = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const pctOf = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const clampBps = (n: number) => Math.max(0, Math.min(SKEW_FEE_MAX_BPS, Math.round(n)));
const shortAddr = (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');

export function SkewFeePanel() {
  const acct = usePredictAccountV2();
  const queryClient = useQueryClient();
  const live = useSkewFeeV2();
  const adminCap = useSkewFeeV2AdminCap();
  // Projection-only fallback rate (localStorage), used when the router isn't published yet.
  const local = useSkewFeeRate();
  const onChain = live.enabled;

  const codeId = predictV2Config.builderCodeId;
  const builder = useBuilderFeeSummary();

  // On-chain edits cost a tx, so the stepper edits a DRAFT and a Save button commits it.
  const [draftBps, setDraftBps] = useState<number | null>(null);
  const committedBps = onChain ? live.feeBps : local.bps;
  const shownBps = onChain ? (draftBps ?? committedBps) : committedBps;
  const setShownBps = onChain ? (v: number) => setDraftBps(clampBps(v)) : local.setBps;
  const resetRate = onChain ? () => setDraftBps(DEFAULT_SKEW_FEE_BPS) : local.reset;
  const dirty = onChain && draftBps != null && draftBps !== live.feeBps;
  const saving = acct.busy === 'skew-fee';

  async function saveOnChain() {
    if (!onChain || draftBps == null || !adminCap.adminCapId) return;
    const digest = await acct.runTx(
      'skew-fee',
      buildSetSkewFeeBpsTx(adminCap.adminCapId, draftBps),
      [qkSkewFeeV2.config(predictV2Config.feeConfigV2Id)],
    );
    if (digest) {
      setDraftBps(null);
      void queryClient.invalidateQueries({ queryKey: qkSkewFeeV2.config(predictV2Config.feeConfigV2Id) });
    }
  }

  // Same query key as BuilderCodePanel's accrual fetch → one shared request, one cache.
  const accrualQ = useQuery({
    queryKey: ['v2', 'builder-code', 'accrual', codeId] as const,
    queryFn: async ({ signal }): Promise<AccrualEvent[]> => {
      const r = await fetch('/api/v2/builder-fee-accrual', { signal });
      if (!r.ok) throw new Error(`accrual ${r.status}`);
      const j = (await r.json()) as { events?: AccrualEvent[] };
      return j.events ?? [];
    },
    enabled: !!codeId,
    staleTime: 60_000,
  });

  const events = useMemo(() => accrualQ.data ?? [], [accrualQ.data]);
  // Projection uses the COMMITTED (live/local) rate, not the unsaved draft.
  const rate = committedBps / 10_000;
  const now = useNow(0);

  const windows = useMemo(() => {
    const agg = (days: number | null) => {
      const cutoff = days == null ? 0 : now - days * DAY;
      let vol = 0;
      let fee = 0;
      for (const e of events) {
        if (e.ts >= cutoff) {
          vol += e.stake;
          fee += e.fee;
        }
      }
      return { vol, fee };
    };
    return { d7: agg(7), d30: agg(30), all: agg(null) };
  }, [events, now]);

  const [assumed, setAssumed] = useState('');
  const assumedVol = Number(assumed.replace(/[^\d.]/g, '')) || 0;

  const loading = accrualQ.isLoading;
  const noVolume = !loading && windows.all.vol === 0;

  return (
    <div className="flex flex-col gap-4">
      {/* What this is — live vs projection. */}
      <div className="glass-card flex items-start gap-3 p-3.5">
        <LuInfo size={16} className="mt-0.5 shrink-0 text-text-3" />
        {onChain ? (
          <p className="text-[12px] leading-relaxed text-text-3">
            The <span className="text-text-1">Skew fee</span> is <span className="text-up">live on-chain</span> —
            a percentage of each bet, charged <span className="text-text-1">on top of</span> the builder fee and
            sent to the treasury on every standard trade. The rate below is the on-chain{' '}
            <span className="text-text-1">FeeConfig</span>; change it here and it takes effect immediately.
            Instant-trading (session) bets are the one exception — they aren&rsquo;t charged yet.
          </p>
        ) : (
          <p className="text-[12px] leading-relaxed text-text-3">
            The <span className="text-text-1">Skew fee</span> is a percentage of each bet, charged{' '}
            <span className="text-text-1">on top of</span> the builder fee. The router isn&rsquo;t published for{' '}
            {predictV2Config.network} yet, so the numbers below are a{' '}
            <span className="text-text-1">projection</span> against your real recent volume.
          </p>
        )}
      </div>

      {/* Rate control. */}
      <div className="glass-card flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-white/[0.02] text-accent">
              <LuPercent size={15} />
            </span>
            <div className="flex flex-col">
              <span className="eyebrow">Skew fee {onChain ? '· live rate' : '· planned'}</span>
              <span className="text-[11px] text-text-3">
                {committedBps} bps · on top of the builder fee
                {onChain && live.treasury ? ` · treasury ${shortAddr(live.treasury)}` : ''}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Stepper bps={shownBps} setBps={setShownBps} disabled={onChain && !adminCap.isAdmin} />
            <button
              type="button"
              onClick={resetRate}
              disabled={onChain && !adminCap.isAdmin}
              title="Reset to default"
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-line px-2.5 text-[11px] text-text-3 transition-colors hover:text-text-1 disabled:opacity-40"
            >
              <LuRotateCcw size={12} />
              {pctOf(DEFAULT_SKEW_FEE_BPS)}
            </button>
          </div>
        </div>

        {/* On-chain: admin gate + Save. */}
        {onChain && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            {adminCap.isAdmin ? (
              <>
                <span className="flex items-center gap-1.5 text-[11px] text-text-3">
                  <LuShieldCheck size={13} className="text-up" /> You hold the fee AdminCap.
                </span>
                <button
                  type="button"
                  onClick={saveOnChain}
                  disabled={!dirty || saving}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-3 text-[12px] font-medium text-accent transition-colors hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <LuCheck size={13} />
                  {saving ? 'Saving…' : dirty ? `Save ${pctOf(shownBps)} on-chain` : 'Saved'}
                </button>
              </>
            ) : (
              <span className="flex items-center gap-1.5 text-[11px] text-text-3">
                <LuShieldCheck size={13} /> Connect the wallet that holds the fee AdminCap to change the rate.
              </span>
            )}
          </div>
        )}
        {acct.error && <span className="text-[11px] leading-relaxed text-down">{acct.error}</span>}
      </div>

      {/* Earnings off REAL volume at the committed rate. */}
      <div className="glass-card overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <span className="flex items-center gap-1.5 text-[12px] font-medium text-text-1">
            <LuTrendingUp size={13} className="text-accent" />
            {onChain ? 'Earnings' : 'Projected earnings'}
          </span>
          <span className="text-[11px] text-text-3">Skew fee at {pctOf(committedBps)} of every bet</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-[12px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-text-3">
                <th className="px-4 py-2 font-medium">Window</th>
                <th className="px-4 py-2 text-right font-medium">Volume (staked)</th>
                <th className="px-4 py-2 text-right font-medium">Builder fee (actual)</th>
                <th className="px-4 py-2 text-right font-medium text-accent">
                  Skew fee {onChain ? '(at live rate)' : '(projected)'}
                </th>
                <th className="px-4 py-2 text-right font-medium">Combined</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              <ProjectionRow label="Last 7 days" window={windows.d7} rate={rate} loading={loading} />
              <ProjectionRow label="Last 30 days" window={windows.d30} rate={rate} loading={loading} />
              <ProjectionRow label="All time" window={windows.all} rate={rate} loading={loading} strong />
            </tbody>
          </table>
        </div>

        {noVolume && (
          <p className="border-t border-line px-4 py-2.5 text-[11px] leading-relaxed text-text-3">
            No attributed volume yet on {predictV2Config.network} — this fills in as trades come through Skew.
            Use the what-if below to model ahead.
          </p>
        )}
      </div>

      {/* What-if — model a bigger monthly volume. */}
      <div className="glass-card flex flex-col gap-3 p-4">
        <span className="eyebrow">What-if · assume a monthly volume</span>
        <div className="flex flex-wrap items-center gap-4">
          <div className="glass-inset inline-flex items-center gap-1.5 rounded-lg px-3 py-2">
            <span className="text-[13px] text-text-3">$</span>
            <input
              type="text"
              inputMode="decimal"
              value={assumed}
              onChange={(e) => setAssumed(e.target.value)}
              placeholder="500,000"
              aria-label="Assumed monthly volume in DUSDC"
              className="w-32 bg-transparent font-mono text-[14px] tabular-nums text-text-1 outline-none placeholder:text-text-3"
            />
            <span className="text-[11px] text-text-3">/mo</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] text-text-3">Skew fee @ {pctOf(committedBps)} =</span>
            <span className="font-mono text-[18px] tabular-nums text-accent">{usd(assumedVol * rate)}</span>
            <span className="text-[11px] text-text-3">/mo</span>
          </div>
          {assumedVol > 0 && (
            <span className="text-[11px] text-text-3">
              ≈ <span className="font-mono tabular-nums text-text-2">{usd0(assumedVol * rate * 12)}</span> / year
            </span>
          )}
        </div>
      </div>

      {/* Context: the builder fee is real money already flowing; skew stacks on top. */}
      <p className="px-1 text-[11px] leading-relaxed text-text-3">
        For reference, the builder fee has earned{' '}
        <span className="font-mono tabular-nums text-text-2">{builder.isLoading ? '…' : usd(builder.lifetime)}</span>{' '}
        to date (live, on-chain). The Skew fee stacks on top of that.
      </p>
    </div>
  );
}

/** −/+ stepper with a typable exact rate, shown as a percentage. Steps 0.25%. */
function Stepper({ bps, setBps, disabled = false }: { bps: number; setBps: (v: number) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const shown = editing ? draft : (bps / 100).toFixed(2);
  const STEP = 25; // bps (0.25%)

  const commit = () => {
    if (draft === null) return;
    const text = draft;
    setDraft(null);
    const p = parseFloat(text.replace(/,/g, ''));
    if (Number.isFinite(p)) setBps(p * 100); // percent → bps
  };

  return (
    <div className={`glass-inset inline-flex items-center gap-0.5 rounded-lg p-0.5 ${disabled ? 'opacity-40' : ''}`}>
      <button
        type="button"
        onClick={() => setBps(bps - STEP)}
        disabled={disabled}
        aria-label="Lower the fee"
        className="ctrl-soft flex h-7 w-7 items-center justify-center rounded-md text-text-2 disabled:cursor-not-allowed"
      >
        −
      </button>
      <div className="inline-flex items-baseline">
        <input
          type="text"
          inputMode="decimal"
          aria-label="Skew fee percentage"
          disabled={disabled}
          value={shown}
          onFocus={(e) => {
            setDraft((bps / 100).toFixed(2));
            e.currentTarget.select();
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setDraft(null);
              e.currentTarget.blur();
            }
          }}
          className="w-14 bg-transparent text-center font-mono text-[14px] tabular-nums text-text-1 outline-none focus-visible:ring-1 focus-visible:ring-accent rounded"
        />
        <span className="pr-1 text-[12px] text-text-3">%</span>
      </div>
      <button
        type="button"
        onClick={() => setBps(bps + STEP)}
        disabled={disabled}
        aria-label="Raise the fee"
        className="ctrl-soft flex h-7 w-7 items-center justify-center rounded-md text-text-2 disabled:cursor-not-allowed"
      >
        +
      </button>
    </div>
  );
}

function ProjectionRow({
  label,
  window,
  rate,
  loading,
  strong = false,
}: {
  label: string;
  window: { vol: number; fee: number };
  rate: number;
  loading: boolean;
  strong?: boolean;
}) {
  const skew = window.vol * rate;
  const combined = window.fee + skew;
  const cell = strong ? 'text-text-1' : 'text-text-2';
  return (
    <tr className={`border-t border-line ${strong ? 'bg-white/[0.02]' : ''}`}>
      <td className={`px-4 py-2.5 font-sans text-[11px] ${strong ? 'font-medium text-text-1' : 'text-text-3'}`}>
        {label}
      </td>
      <td className={`px-4 py-2.5 text-right ${cell}`}>{loading ? '…' : usd0(window.vol)}</td>
      <td className={`px-4 py-2.5 text-right ${cell}`}>{loading ? '…' : usd(window.fee)}</td>
      <td className="px-4 py-2.5 text-right text-accent">{loading ? '…' : usd(skew)}</td>
      <td className={`px-4 py-2.5 text-right ${strong ? 'font-medium text-text-1' : 'text-text-1'}`}>
        {loading ? '…' : usd(combined)}
      </td>
    </tr>
  );
}
