'use client';

/**
 * Vault deposit panel — supply DUSDC into the PLP vault, with an optional
 * crash-insurance hedge.
 *
 *  - Hedge OFF (default): plain predict::supply<DUSDC> → PLP to the wallet. No
 *    manager, no oracle, no quote — the lowest-friction LP action.
 *  - Hedge ON: "PLP yield minus crash insurance" in one atomic transaction —
 *    most of the deposit is supplied into PLP, a small sleeve buys a downside
 *    "crash" binary that pays when a sharp drop would hurt PLP. Routed through
 *    predict_hedge::open_hedged_and_keep, signed by the user (trustless).
 *    Pricing is chain-authoritative (quoteMarket); strike via selectDownHedge.
 */
import { useMemo, useState } from 'react';
import { useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery } from '@tanstack/react-query';
import { LuShieldCheck, LuCoins, LuTrendingDown, LuLayers, LuArrowDown } from 'react-icons/lu';
import { usePredictAccount } from '@/lib/hooks/use-predict-account';
import { useNow } from '@/lib/hooks/use-now';
import { useMounted } from '@/lib/hooks/use-mounted';
import { selectDownHedge } from '@/lib/hedge/select';
import { quoteMarket } from '@/lib/sui/quote';
import { buildOpenHedgedTx } from '@/lib/sui/predict-tx';
import { toQuote, fromQuote } from '@/config/scale';
import { quote as fmtQuote, price, pct, dateUTC, countdown } from '@/lib/format';
import { predictConfig } from '@/config/predict';
import { qk } from '@/lib/api/client';
import { HUE, IconChip } from '../ui/metric';
import type { SmileInput } from '@/lib/svi/surface';

const PROBE = 1_000_000n; // 1 contract, for per-unit pricing
const MIN_RUNWAY_MS = 120_000; // skip oracles about to settle

export function HedgePanel({ inputs, serverNow }: { inputs: SmileInput[]; serverNow: number }) {
  const acct = usePredictAccount();
  const client = useCurrentClient();
  const now = useNow(serverNow);
  const mounted = useMounted();

  const [depositStr, setDepositStr] = useState('10');
  const [hedgePct, setHedgePct] = useState(5);
  // Default OFF: plain supply is the baseline LP action; hedge is opt-in.
  const [hedgeOn, setHedgeOn] = useState(false);

  // Hedge against the longest-dated still-live oracle (most variance + runway).
  const chosen = useMemo(() => {
    const live = inputs
      .filter((i) => i.oracle.expiry > now + MIN_RUNWAY_MS)
      .sort((a, b) => b.oracle.expiry - a.oracle.expiry);
    return live[0] ?? null;
  }, [inputs, now]);

  const hedge = useMemo(() => (chosen ? selectDownHedge(chosen) : null), [chosen]);

  // Chain-authoritative per-contract ask for the hedge leg. Only fetched while
  // the hedge is toggled on — plain supply needs no quote.
  const quoteQ = useQuery({
    queryKey: ['hedge-quote', hedge?.oracleId, hedge?.strikeScaled.toString()],
    queryFn: () =>
      quoteMarket(client.core, {
        sender: acct.owner!,
        oracleId: hedge!.oracleId,
        expiry: hedge!.expiry,
        strike: hedge!.strikeScaled,
        isUp: false,
        quantity: PROBE,
      }),
    enabled: hedgeOn && !!hedge && !!acct.owner,
    refetchInterval: 10_000,
    retry: 0,
  });

  const deposit = parseFloat(depositStr) || 0;
  const depositBase = deposit > 0 ? toQuote(deposit) : 0n;
  // With no hedge, the entire deposit is supplied into PLP.
  const hedgeBudgetBase = hedgeOn ? (depositBase * BigInt(Math.round(hedgePct * 100))) / 10_000n : 0n;
  const supplyBase = depositBase - hedgeBudgetBase;
  const askPerContract = quoteQ.data?.mintCost ?? 0n; // base units per 1.0 contract
  const hedgeQty = askPerContract > 0n ? (hedgeBudgetBase * PROBE) / askPerContract : 0n;
  const hedgeCostBase = (askPerContract * hedgeQty) / PROBE;
  const maxCrashPayout = fromQuote(hedgeQty); // each contract pays $1 if it hits

  const walletDusdc = acct.dusdcBalance ?? 0n;
  const notDeployed = !predictConfig.hedgePackageId;

  // Two state machines: the hedged path needs a manager, a live oracle, and a
  // chain quote; plain supply needs none of those.
  const reason = !mounted
    ? null
    : !acct.owner
      ? 'connect'
      : !hedgeOn
        ? depositBase <= 0n
          ? 'enter-amount'
          : depositBase > walletDusdc
            ? 'insufficient'
            : 'ready'
        : notDeployed
          ? 'not-deployed'
          : !chosen || !hedge
            ? 'no-oracle'
            : !acct.managerId
              ? 'no-manager'
              : depositBase <= 0n
                ? 'enter-amount'
                : depositBase > walletDusdc
                  ? 'insufficient'
                  : supplyBase <= 0n
                    ? 'supply-zero'
                    : askPerContract <= 0n
                      ? quoteQ.isError
                        ? 'unquotable'
                        : 'pricing'
                      : hedgeQty <= 0n
                        ? 'budget-too-small'
                        : 'ready';

  async function supply() {
    if (reason !== 'ready') return;
    await acct.supplyPlp(depositBase);
    setDepositStr('');
  }

  async function open() {
    if (reason !== 'ready' || !hedge) return;
    await acct.runTx(
      'open-hedged',
      buildOpenHedgedTx({
        managerId: acct.managerId!,
        oracleId: hedge.oracleId,
        expiry: hedge.expiry,
        hedgeStrike: hedge.strikeScaled,
        hedgeIsUp: false,
        hedgeQuantity: hedgeQty,
        hedgeBudget: hedgeBudgetBase,
        supplyAmount: supplyBase,
      }),
      [
        ...acct.managerKeys,
        qk.dusdcBalance(acct.owner ?? ''),
        qk.plpBalance(acct.owner ?? ''),
        qk.lpFlows(acct.owner ?? ''),
        qk.vaultSummary,
      ],
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-5">
      <div className="mb-5">
        <h1 className="flex items-center gap-2 text-[20px] font-semibold tracking-tight text-text-1">
          {hedgeOn ? (
            <LuShieldCheck size={18} className="text-[var(--accent)]" />
          ) : (
            <LuLayers size={18} className="text-[var(--accent)]" />
          )}
          {hedgeOn ? 'Add with crash protection' : 'Add to the pool'}
        </h1>
        <p className="mt-1 text-[12px] leading-relaxed text-text-3">
          {hedgeOn ? (
            <>
              Earn from the pool, with built-in crash protection. Most of your deposit goes into the
              shared pool to earn a share of the trading fees; a small part buys protection that pays out
              if {chosen?.oracle.underlying_asset ?? 'BTC'} drops sharply — softening the pool&apos;s worst day. It all
              happens in one transaction.
            </>
          ) : (
            <>
              Add DUSDC to the shared pool and earn a share of the trading fees. In return you get pool
              shares, whose value rises and falls with the pool. Take your money out any time below. Flip
              the switch to also buy crash protection.
            </>
          )}
        </p>
      </div>

      <div className="glass-card flex flex-col gap-4 p-4 font-mono tabular-nums">
        {/* Deposit */}
        <label className="flex flex-col gap-1.5">
          <span className="eyebrow">Deposit ({predictConfig.quote.symbol})</span>
          <div className="glass-inset flex items-center gap-2 px-3 py-2.5">
            <input
              inputMode="decimal"
              value={depositStr}
              onChange={(e) => setDepositStr(e.target.value.replace(/[^0-9.]/g, ''))}
              className="w-full bg-transparent text-[18px] text-text-1 outline-none"
              placeholder="0.0"
            />
            <button
              onClick={() => setDepositStr(String(fromQuote(walletDusdc)))}
              className="ctrl-soft shrink-0 rounded-md px-2 py-1 text-[10px] uppercase tracking-wider text-text-2"
            >
              Max
            </button>
          </div>
          <span className="text-[10px] text-text-3">
            Wallet: {mounted ? fmtQuote(fromQuote(walletDusdc)) : '…'} {predictConfig.quote.symbol}
          </span>
        </label>

        {/* Hedge toggle */}
        <button
          type="button"
          role="switch"
          aria-checked={hedgeOn}
          onClick={() => setHedgeOn((v) => !v)}
          className="glass-inset flex items-center justify-between gap-3 p-3 text-left transition-colors hover:bg-white/[0.02]"
        >
          <div className="flex items-center gap-2.5">
            <LuShieldCheck size={16} className={hedgeOn ? 'text-[var(--accent)]' : 'text-text-3'} />
            <div className="flex flex-col">
              <span className="text-[13px] text-text-1">Add crash protection</span>
              <span className="font-sans text-[11px] text-text-3">
                {hedgeOn ? 'Part of your deposit buys protection against a crash' : 'Optional — add to the pool without it'}
              </span>
            </div>
          </div>
          <span
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${hedgeOn ? 'bg-[var(--accent-soft)]' : 'bg-white/[0.08]'}`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-text-1 transition-transform ${hedgeOn ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
            />
          </span>
        </button>

        {hedgeOn ? (
          <>
            {/* Hedge allocation */}
            <label className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between">
                <span className="eyebrow">Protection budget</span>
                <span className="text-[12px] text-text-1">{hedgePct}%</span>
              </div>
              <input
                type="range"
                min={1}
                max={20}
                step={1}
                value={hedgePct}
                onChange={(e) => setHedgePct(Number(e.target.value))}
                className="surface-scrub w-full"
              />
              <span className="text-[10px] text-text-3">
                {fmtQuote(fromQuote(hedgeBudgetBase))} to protection · {fmtQuote(fromQuote(supplyBase))} to the pool
              </span>
            </label>

            {/* Auto-selected hedge */}
            <div className="glass-inset flex items-center justify-between gap-3 p-3">
              <div className="flex items-center gap-2.5">
                <span className="dir-orb down scale-90" aria-hidden>
                  <LuArrowDown size={18} />
                </span>
                <div className="flex flex-col">
                  <span className="text-[13px] text-text-1">
                    {chosen?.oracle.underlying_asset ?? 'BTC'} ≤ {hedge ? price(hedge.strike, 0) : '—'}
                  </span>
                  <span className="font-sans text-[11px] text-text-3">
                    {hedge ? `${pct(hedge.otmPct, 1)} below today's price` : 'no live market'} ·{' '}
                    {chosen ? `expires ${dateUTC(chosen.oracle.expiry)} (${countdown(chosen.oracle.expiry, now)})` : '—'}
                  </span>
                </div>
              </div>
              <div className="flex flex-col items-end">
                <span className="eyebrow">Cost each</span>
                <span className="text-[13px] text-text-1">
                  {askPerContract > 0n ? pct(fromQuote(askPerContract), 1) : '—'}
                </span>
              </div>
            </div>

            {/* Preview */}
            <div className="grid grid-cols-2 gap-2.5">
              <Stat icon={LuLayers} color={HUE.teal} label="Into the pool" value={fmtQuote(fromQuote(supplyBase))} unit={predictConfig.quote.symbol} />
              <Stat icon={LuCoins} color={HUE.amber} label="Protection cost" value={fmtQuote(fromQuote(hedgeCostBase))} unit={predictConfig.quote.symbol} />
              <Stat icon={LuShieldCheck} color={HUE.blue} label="Protection size" value={fmtQuote(maxCrashPayout)} unit="units" />
              <Stat icon={LuTrendingDown} color={HUE.coral} label="Pays if it crashes" value={fmtQuote(maxCrashPayout)} unit={predictConfig.quote.symbol} />
            </div>

            {hedge && hedgeQty > 0n && (
              <p className="font-sans text-[11px] leading-relaxed text-text-3">
                If {chosen?.oracle.underlying_asset ?? 'BTC'} finishes below {price(hedge.strike, 0)}, the protection
                pays {fmtQuote(maxCrashPayout)} {predictConfig.quote.symbol} — offsetting the pool&apos;s loss. If it
                doesn&apos;t, the protection simply expires, and its cost was the price of insurance.
              </p>
            )}
          </>
        ) : (
          <div className="grid grid-cols-1 gap-2.5">
            <Stat icon={LuLayers} color={HUE.teal} label="Into the pool" value={fmtQuote(fromQuote(supplyBase))} unit={predictConfig.quote.symbol} />
          </div>
        )}

        {acct.error && (
          <div className="rounded-lg border border-down/40 bg-down/10 p-2 text-[12px] text-down">{acct.error}</div>
        )}

        <ActionButton
          reason={reason}
          busy={acct.busy}
          hedgeOn={hedgeOn}
          onCreate={acct.createManager}
          onSupply={supply}
          onOpen={open}
        />
      </div>

      <p className="mt-4 text-[10px] leading-relaxed text-text-3">
        You hold your own pool shares and crash protection directly — Skew never takes custody. More
        pooling options are coming soon. {predictConfig.quote.symbol} · {predictConfig.network}.
      </p>
    </div>
  );
}

function ActionButton({
  reason,
  busy,
  hedgeOn,
  onCreate,
  onSupply,
  onOpen,
}: {
  reason: string | null;
  busy: string | null;
  hedgeOn: boolean;
  onCreate: () => void;
  onSupply: () => void;
  onOpen: () => void;
}) {
  if (reason === null) {
    return <div className="h-11 animate-pulse rounded-lg bg-white/[0.04]" />;
  }
  if (reason === 'no-manager') {
    return (
      <button
        onClick={onCreate}
        disabled={busy === 'create'}
        className="h-11 rounded-lg border border-line-strong bg-up/10 text-[13px] font-semibold text-up hover:bg-up/20 disabled:opacity-50"
      >
        {busy === 'create' ? 'creating account…' : 'Create trading account first'}
      </button>
    );
  }
  const readyLabel = hedgeOn
    ? busy === 'open-hedged'
      ? 'adding…'
      : 'Add with protection'
    : busy === 'supply-plp'
      ? 'adding…'
      : 'Add to the pool';
  const label: Record<string, string> = {
    connect: 'Connect a wallet',
    'not-deployed': 'Crash protection isn’t available on this network',
    'no-oracle': 'No live market to protect against right now',
    'enter-amount': 'Enter an amount',
    insufficient: 'Not enough DUSDC in your wallet',
    'supply-zero': 'Lower the protection budget',
    pricing: 'Getting the price…',
    unquotable: 'Couldn’t price the protection — try again',
    'budget-too-small': 'Increase your amount or the protection %',
    ready: readyLabel,
  };
  const disabled = reason !== 'ready' || !!busy;
  return (
    <button
      onClick={hedgeOn ? onOpen : onSupply}
      disabled={disabled}
      className={`h-11 rounded-lg text-[13px] font-semibold transition-all ${
        reason === 'ready'
          ? 'border border-[var(--accent-line)] bg-[var(--accent-soft)] text-up shadow-[0_0_22px_-8px_var(--accent-glow)] hover:bg-up/15'
          : 'border border-line text-text-3'
      } disabled:opacity-60`}
    >
      {label[reason] ?? readyLabel}
    </button>
  );
}

function Stat({
  icon: Icon,
  color,
  label,
  value,
  unit,
}: {
  icon: typeof LuLayers;
  color: string;
  label: string;
  value: string;
  unit: string;
}) {
  return (
    <div className="glass-inset flex flex-col gap-1.5 p-3">
      <div className="flex items-center gap-2">
        <IconChip icon={Icon} color={color} size={20} />
        <span className="eyebrow">{label}</span>
      </div>
      <span className="text-[16px] leading-none text-text-1">
        {value}
        <span className="ml-1 text-[10px] text-text-3">{unit}</span>
      </span>
    </div>
  );
}
