'use client';

/**
 * SimpleScreen — the calm UP/DOWN "round" trade view (`/v2/simple`).
 *
 * One live market at a time (the soonest tradeable one of the chosen cadence),
 * shown as a little price chart with the round's pinned LINE, a countdown, and
 * two big UP/DOWN buttons. The trader enters exactly two things: how much, and
 * which way. Everything else (the market, the strike/line, 1x leverage) is picked
 * for them. It reuses the SAME markets / pricer / mint plumbing as the full
 * ticket, so its trades land on the leaderboard, portfolio and PnL like any other
 * — it's a front-end, not a second engine. See [[simple-mode]].
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LuArrowUp, LuArrowDown, LuInfo } from 'react-icons/lu';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useSkewFeeV2 } from '@/lib/hooks/use-skew-fee-v2';
import { skewFeeBase } from '@/lib/sui/v2/skew-fee';
import { useV2Markets } from '@/lib/hooks/use-v2-markets';
import { useV2Pricer } from '@/lib/hooks/use-v2-pricer';
import { usePythTapeFeed } from '@/lib/hooks/use-v2-pyth-history';
import { useNow } from '@/lib/hooks/use-now';
import { getV2MarketState, qkV2 } from '@/lib/api/v2/client';
import { groupByCadence, isTooCloseToExpiry, type V2Cadence } from '@/lib/markets/v2-discovery';
import { roundLineScaled, quoteSide, type SideQuote } from '@/lib/sui/v2/simple-round';
import { leverageScaled } from '@/lib/sui/v2/ticks';
import { toFloat, fromQuote } from '@/config/scale';
import { price, pct } from '@/lib/format';
import { STARTER_DEFAULT_STAKE, defaultStakeForBalance, betPresets } from '@/lib/store/v2-trade-store';
import { useSessionPrefs } from '@/lib/store/session-prefs-store';
import { SimpleRoundChart } from './simple-chart';
import { TradeModeToggle } from '../trade-mode-toggle';
import { GlassError } from '../../ui/glass-error';
import { MintConfirmModal, type ConfirmRow } from '@/app/_components/mint-confirm-modal';
import { MintSuccessModal } from '@/app/_components/mint-success-modal';
import { SessionOptInRow } from '../session/session-opt-in-row';
import { predictV2Config, ACTIVE_NETWORK, V2_SIMPLE_ENABLED } from '@/config/predict';
import type { V2Market, V2MarketState } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

const SYM = predictV2Config.quote.symbol;
const usd = (base: bigint) => `$${fromQuote(base).toFixed(2)} ${SYM}`;

const CADENCES: { id: V2Cadence; label: string }[] = [
  { id: '1m', label: '1 min' },
  { id: '5m', label: '5 min' },
  { id: '1h', label: '1 hour' },
];
const CADENCE_SECS: Record<V2Cadence, number> = { '1m': 60, '5m': 300, '1h': 3600 };

type SuccessState = { headline: string; tone: 'up' | 'down'; rows: ConfirmRow[]; staked: string; maxWin: string; digest: string };

export function SimpleScreen({
  markets: initialMarkets,
  pricerSeeds,
  stateSeeds,
  serverNow,
}: {
  markets: V2Market[];
  pricerSeeds: Record<string, LivePricer>;
  stateSeeds: Record<string, V2MarketState>;
  serverNow: number;
}) {
  const acct = usePredictAccountV2();
  const skewFee = useSkewFeeV2();
  // Keep the rolling pyth-tape buffer fed (and the live spot read on the checkpoint
  // stream) for as long as this screen is mounted. The chart's history walk is a
  // one-shot, so the tape is what keeps its right-hand side current — without it the
  // chart draws a straight line from a frozen tail to the live tick.
  usePythTapeFeed();
  const instantTrade = useSessionPrefs((s) => s.instantTrade);
  const armInstant = useSessionPrefs((s) => s.armInstant);
  const setArmInstant = useSessionPrefs((s) => s.setArmInstant);
  const sessionDuration = useSessionPrefs((s) => s.sessionDuration);

  const markets = useV2Markets(initialMarkets);
  const now = useNow(serverNow);
  const [cadence, setCadence] = useState<V2Cadence>('1m');
  const [stake, setStake] = useState(STARTER_DEFAULT_STAKE);
  const [confirm, setConfirm] = useState<{ isUp: boolean } | null>(null);
  const [success, setSuccess] = useState<SuccessState | null>(null);

  // The active round: soonest tradeable market of the chosen cadence (skip any so
  // close to expiry a mint can't land), falling back to the soonest of that cadence.
  const grouped = useMemo(() => groupByCadence(markets), [markets]);
  const active = useMemo(() => {
    const list = grouped[cadence];
    return list.find((m) => !isTooCloseToExpiry(m, now)) ?? list[0] ?? null;
  }, [grouped, cadence, now]);
  const marketId = active?.expiry_market_id ?? null;

  const pricerQ = useV2Pricer(marketId, marketId ? pricerSeeds[marketId] : undefined);
  const pricer = pricerQ.data ?? null;

  // The pinned line comes from the market's on-chain reference_tick; seed it from
  // the server so the line paints immediately instead of flashing at-the-money.
  const stateQ = useQuery({
    queryKey: qkV2.marketState(marketId ?? ''),
    queryFn: () => getV2MarketState(marketId!),
    enabled: !!marketId,
    initialData: marketId ? stateSeeds[marketId] : undefined,
    refetchInterval: 8_000,
    staleTime: 5_000,
  });
  const refTick = stateQ.data?.reference_tick ?? null;

  const lineInfo = useMemo(
    () => (active && pricer ? roundLineScaled(refTick, pricer.forward, active.tick_size, active.admission_tick_size) : null),
    [active, pricer, refTick],
  );
  const line = lineInfo ? toFloat(lineInfo.lineScaled) : null;

  const upQ = useMemo(
    () => (active && pricer && lineInfo ? quoteSide(active, pricer, lineInfo.lineScaled, stake, true) : null),
    [active, pricer, lineInfo, stake],
  );
  const dnQ = useMemo(
    () => (active && pricer && lineInfo ? quoteSide(active, pricer, lineInfo.lineScaled, stake, false) : null),
    [active, pricer, lineInfo, stake],
  );

  // One-time balance-aware default stake — adjusted DURING render (React's "you
  // might not need an effect"; the mobile dock uses the same pattern for route
  // changes), so it never trips set-state-in-effect. Fires once the balance loads,
  // and only while the trader hasn't picked an amount yet.
  const [autoSized, setAutoSized] = useState(false);
  if (!autoSized && acct.walletDusdcBase !== undefined) {
    setAutoSized(true);
    if (stake === STARTER_DEFAULT_STAKE) {
      const s = defaultStakeForBalance(acct.balanceBase + acct.walletDusdcBase);
      if (s !== stake) setStake(s);
    }
  }

  const spendable = acct.balanceBase + (acct.walletDusdcBase ?? 0n);
  const presets = useMemo(() => betPresets(spendable), [spendable]);

  /** Fee-aware funding for a side — the Skew fee rides the owner path only, so a
   *  session-routed trade is fee-free (mirrors the ticket). */
  function funding(q: SideQuote) {
    const feeAmt = skewFee.enabled ? skewFeeBase(q.stakeBase, skewFee.feeBps) : 0n;
    const baseShort = q.maxCost > acct.balanceBase ? q.maxCost - acct.balanceBase : 0n;
    const willRouteSession = acct.sessionCanTrade && baseShort === 0n;
    const chargesSkewFee = feeAmt > 0n && !willRouteSession;
    const skewFeeDue = chargesSkewFee ? feeAmt : 0n;
    const required = q.maxCost + skewFeeDue;
    const shortfall = required > acct.balanceBase ? required - acct.balanceBase : 0n;
    return { shortfall, skewFeeDue, chargesSkewFee };
  }

  function requestPlace(isUp: boolean) {
    if (acct.busy || !active) return;
    if (!acct.owner) return; // buttons show a connect hint instead
    if (!acct.wrapperExists) {
      void acct.createAccount();
      return;
    }
    const q = isUp ? upQ : dnQ;
    if (!q || !q.quotable) return;
    const f = funding(q);
    // One-tap only when a session is live AND the trade is fully account-funded
    // (a wallet top-up would still pop up).
    if (acct.sessionCanTrade && instantTrade && f.shortfall === 0n) {
      void doMint(isUp);
      return;
    }
    setConfirm({ isUp });
  }

  async function doMint(isUp: boolean) {
    const q = isUp ? upQ : dnQ;
    if (!active || !q || line == null) return;
    const f = funding(q);
    const wasArming = armInstant && !acct.sessionActive;
    const digest = await acct.mintBudget(
      {
        marketId: active.expiry_market_id,
        lowerTick: q.ticks.lowerTick,
        higherTick: q.ticks.higherTick,
        amount: q.amount,
        minQuantity: q.minQuantity,
        leverage: leverageScaled(1),
        deposit: f.shortfall > 0n ? f.shortfall : undefined,
        skewFee: f.chargesSkewFee ? { stake: q.stakeBase, feeBps: skewFee.feeBps, isRange: false } : undefined,
      },
      { silentSuccess: true, startSession: wasArming ? { duration: sessionDuration } : undefined },
    );
    setConfirm(null);
    if (digest) {
      if (wasArming) setArmInstant(false);
      setSuccess({
        headline: `BTC · ${isUp ? 'UP' : 'DOWN'}`,
        tone: isUp ? 'up' : 'down',
        rows: reviewRows(isUp, line, f.chargesSkewFee ? { due: f.skewFeeDue, bps: skewFee.feeBps } : undefined),
        staked: usd(q.stakeBase),
        maxWin: usd(q.winBase),
        digest,
      });
    }
  }

  const secsLeft = active ? Math.max(0, Math.round((active.expiry - now) / 1000)) : 0;
  const timer = `${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, '0')}`;
  const remainFrac = Math.max(0, Math.min(1, secsLeft / CADENCE_SECS[cadence]));
  const px = pricer?.forward ?? null;
  const above = px != null && line != null ? px >= line : true;
  const delta = px != null && line != null ? px - line : null;
  const upProb = upQ?.entryProb ?? null;

  const cq = confirm ? (confirm.isUp ? upQ : dnQ) : null;
  const cf = cq ? funding(cq) : null;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-3 py-4 sm:px-5">
      {/* mobile mode switch (desktop gets it in the header) */}
      {V2_SIMPLE_ENABLED && (
        <div className="mb-3 lg:hidden">
          <TradeModeToggle variant="full" />
        </div>
      )}

      {/* title + cadence */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-[15px] font-semibold tracking-tight text-text-1 sm:text-[17px]">
          Will Bitcoin be higher or lower{' '}
          {line != null && (
            <>
              than <span className="font-mono text-text-1">{price(line)}</span>
            </>
          )}{' '}
          this round?
        </h1>
        <div className="flex shrink-0 gap-1.5 rounded-xl border border-(--line-soft) bg-bg-1 p-1">
          {CADENCES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCadence(c.id)}
              className={`rounded-lg px-3 py-1.5 font-mono text-[12px] font-semibold transition-colors ${
                cadence === c.id ? 'bg-bg-3 text-text-1' : 'text-text-3 hover:text-text-2'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {!active || !pricer || line == null ? (
        <div className="flex flex-1 items-center justify-center rounded-2xl border border-(--line-soft) bg-bg-1 py-24 text-center text-[13px] text-text-3">
          {markets.length === 0 ? 'No live rounds right now — check back in a moment.' : 'Starting the next round…'}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          {/* chart + countdown */}
          <section className="panel flex flex-col gap-3 p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="eyebrow">Last price</div>
                <div className="font-mono text-[32px] font-semibold leading-none tabular-nums text-text-1 sm:text-[38px]">
                  {price(px ?? 0)}
                </div>
                {delta != null && (
                  <div className={`mt-1.5 text-[12.5px] font-semibold ${above ? 'text-up' : 'text-down'}`}>
                    {above ? '▲' : '▼'} {price(Math.abs(delta))} {above ? 'above' : 'below'} the line
                  </div>
                )}
              </div>
              <div className="text-right">
                <div className="eyebrow">Round closes in</div>
                <div className="font-mono text-[28px] font-semibold leading-none tabular-nums text-text-1 sm:text-[34px]">
                  {timer}
                </div>
              </div>
            </div>
            <div className="meter">
              <i style={{ width: `${remainFrac * 100}%`, background: 'var(--accent)' }} />
            </div>
            {/* fills the rest of the panel so there's no dead space below it */}
            <div className="min-h-0 flex-1">
              <SimpleRoundChart line={line} above={above} />
            </div>
          </section>

          {/* the ticket */}
          <aside className="panel flex flex-col gap-4 p-4">
            <div className="flex flex-col gap-1">
              <span className="eyebrow">The line · this round</span>
              <span className="font-mono text-[19px] font-semibold tabular-nums text-text-1">{price(line)}</span>
              <span className="text-[11px] text-text-3">
                {lineInfo?.pinned ? 'Fixed for this round — settles above or below it.' : 'The price right now — higher or lower from here.'}
              </span>
            </div>

            {upProb != null && (
              <div className="flex flex-col gap-1.5">
                <span className="eyebrow">Market&rsquo;s read</span>
                <div className="flex h-2 overflow-hidden rounded-full bg-bg-3">
                  <span style={{ width: `${upProb * 100}%`, background: 'var(--up)' }} />
                  <span style={{ width: `${(1 - upProb) * 100}%`, background: 'var(--down)' }} />
                </div>
                <div className="flex justify-between text-[11px] font-semibold">
                  <span className="text-up">UP {pct(upProb, 0)}</span>
                  <span className="text-down">{pct(1 - upProb, 0)} DOWN</span>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="eyebrow">How much</span>
                <span className="text-[11px] text-text-3">You have ${fromQuote(spendable).toFixed(2)}</span>
              </div>
              <div className="flex gap-1.5">
                {presets.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setStake(p)}
                    className={`flex-1 rounded-lg border py-2 font-mono text-[13px] font-semibold transition-colors ${
                      stake === p
                        ? 'border-(--accent-line) bg-(--accent-soft) text-text-1'
                        : 'border-(--line-soft) bg-bg-2 text-text-2 hover:text-text-1'
                    }`}
                  >
                    ${p}
                  </button>
                ))}
              </div>
              <input
                type="number"
                inputMode="decimal"
                min={1}
                value={stake}
                onChange={(e) => setStake(Math.max(0, Number(e.target.value) || 0))}
                aria-label="Custom amount"
                className="w-full rounded-lg border border-(--line-soft) bg-bg-2 px-3 py-2 text-center font-mono text-[14px] text-text-1 outline-none focus:border-(--line-strong)"
              />
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <SideButton isUp q={upQ} onPick={() => requestPlace(true)} disabled={!acct.owner || !!acct.busy} />
              <SideButton isUp={false} q={dnQ} onPick={() => requestPlace(false)} disabled={!acct.owner || !!acct.busy} />
            </div>

            {!acct.owner ? (
              <p className="text-center text-[11.5px] text-text-3">Connect your wallet (top right) to place a bet.</p>
            ) : !acct.wrapperExists ? (
              <p className="text-center text-[11.5px] text-text-3">
                {acct.busy === 'create' ? 'Setting up your free trading account…' : 'Your first tap sets up a free trading account, then tap again to bet.'}
              </p>
            ) : (
              <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-text-3">
                <LuInfo size={12} /> Payouts are after the {skewFee.enabled ? `${(skewFee.feeBps / 100).toFixed(2)}% ` : ''}fee. A fresh round starts every {CADENCES.find((c) => c.id === cadence)?.label}.
              </p>
            )}

            {acct.error && <GlassError message={acct.error} onDismiss={acct.clearError} />}
          </aside>
        </div>
      )}

      {/* confirm */}
      {cq && line != null && (
        <MintConfirmModal
          open={!!confirm}
          onClose={() => setConfirm(null)}
          onConfirm={() => confirm && doMint(confirm.isUp)}
          busy={acct.busy === 'mint'}
          headline={`BTC · ${confirm?.isUp ? 'UP' : 'DOWN'}`}
          tone={confirm?.isUp ? 'up' : 'down'}
          rows={reviewRows(!!confirm?.isUp, line, cf?.chargesSkewFee ? { due: cf.skewFeeDue, bps: skewFee.feeBps } : undefined)}
          cost={usd(cq.stakeBase)}
          maxWin={usd(cq.winBase)}
          confirmLabel={`Bet ${confirm?.isUp ? 'UP' : 'DOWN'} · ${usd(cq.stakeBase)}`}
          subtitle={
            acct.sessionCanTrade
              ? 'Instant trading is on — this places with no wallet pop-up.'
              : acct.gasless
                ? 'Signed in with Google — places instantly, no wallet pop-up.'
                : 'Review your bet, then approve it in your wallet.'
          }
          extra={<SessionOptInRow />}
        />
      )}

      {success && (
        <MintSuccessModal
          open
          onClose={() => setSuccess(null)}
          headline={success.headline}
          tone={success.tone}
          rows={success.rows}
          staked={success.staked}
          maxWin={success.maxWin}
          digest={success.digest}
          network={ACTIVE_NETWORK}
          positionsHref="/v2/portfolio"
        />
      )}
    </main>
  );
}

/** The confirm/success summary rows for a round bet. */
function reviewRows(isUp: boolean, line: number, fee?: { due: bigint; bps: number }): ConfirmRow[] {
  const rows: ConfirmRow[] = [
    { label: 'Your call', value: isUp ? 'Closes ABOVE the line' : 'Closes BELOW the line' },
    { label: 'The line', value: price(line), emphasize: true },
  ];
  if (fee) rows.push({ label: `Skew fee (${(fee.bps / 100).toFixed(2)}%)`, value: usd(fee.due) });
  return rows;
}

function SideButton({
  isUp,
  q,
  onPick,
  disabled,
}: {
  isUp: boolean;
  q: SideQuote | null;
  onPick: () => void;
  disabled: boolean;
}) {
  const off = disabled || !q || !q.quotable;
  const tone = isUp ? 'up' : 'down';
  const Arrow = isUp ? LuArrowUp : LuArrowDown;
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={off}
      className={`group relative flex flex-col items-center gap-2 overflow-hidden rounded-2xl border p-4 text-center transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 ${
        isUp ? 'border-up/25 hover:border-up/45' : 'border-down/25 hover:border-down/45'
      }`}
      style={{
        background: `radial-gradient(130% 90% at 50% 0%, ${isUp ? 'rgba(77,214,176,0.12)' : 'rgba(240,121,107,0.12)'}, transparent 55%), var(--bg-1)`,
      }}
    >
      <span className={`dir-orb ${tone}`}>
        <Arrow size={20} />
      </span>
      <span className="flex flex-col gap-0.5">
        <span className={`text-[15px] font-bold ${isUp ? 'text-up' : 'text-down'}`}>{isUp ? 'UP' : 'DOWN'}</span>
        <span className="text-[10.5px] text-text-3">{isUp ? 'closes above' : 'closes below'}</span>
      </span>
      <span className="mt-1 w-full border-t border-(--line-soft) pt-2.5">
        {q && q.quotable ? (
          <>
            <span className="block font-mono text-[16px] font-semibold tabular-nums text-text-1">{q.multiplier.toFixed(2)}×</span>
            <span className="block text-[10.5px] text-text-2">
              win <b className="font-mono text-text-1">{usd(q.winBase)}</b>
            </span>
          </>
        ) : (
          <span className="block text-[10.5px] text-text-3">too one-sided to price</span>
        )}
      </span>
    </button>
  );
}
