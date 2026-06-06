'use client';

/**
 * Hedge Vault — "PLP yield minus crash insurance" in one atomic transaction.
 * Deposit DUSDC → most is supplied into the PLP vault (earns the house edge),
 * a small sleeve buys a downside "crash" binary that pays exactly when a sharp
 * drop would hurt PLP. Routed through our predict_hedge::open_hedged_and_keep
 * router, signed by the user (trustless, no operator). Pricing is chain-
 * authoritative (quoteMarket); strike selection is selectDownHedge.
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

  // Hedge against the longest-dated still-live oracle (most variance + runway).
  const chosen = useMemo(() => {
    const live = inputs
      .filter((i) => i.oracle.expiry > now + MIN_RUNWAY_MS)
      .sort((a, b) => b.oracle.expiry - a.oracle.expiry);
    return live[0] ?? null;
  }, [inputs, now]);

  const hedge = useMemo(() => (chosen ? selectDownHedge(chosen) : null), [chosen]);

  // Chain-authoritative per-contract ask for the hedge leg.
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
    enabled: !!hedge && !!acct.owner,
    refetchInterval: 10_000,
    retry: 0,
  });

  const deposit = parseFloat(depositStr) || 0;
  const depositBase = deposit > 0 ? toQuote(deposit) : 0n;
  const hedgeBudgetBase = (depositBase * BigInt(Math.round(hedgePct * 100))) / 10_000n;
  const supplyBase = depositBase - hedgeBudgetBase;
  const askPerContract = quoteQ.data?.mintCost ?? 0n; // base units per 1.0 contract
  const hedgeQty = askPerContract > 0n ? (hedgeBudgetBase * PROBE) / askPerContract : 0n;
  const hedgeCostBase = (askPerContract * hedgeQty) / PROBE;
  const maxCrashPayout = fromQuote(hedgeQty); // each contract pays $1 if it hits

  const walletDusdc = acct.dusdcBalance ?? 0n;
  const notDeployed = !predictConfig.hedgePackageId;

  const reason = !mounted
    ? null
    : !acct.owner
      ? 'connect'
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
      [...acct.managerKeys, qk.dusdcBalance(acct.owner ?? '')],
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-6">
      <div className="mb-5">
        <h1 className="flex items-center gap-2 text-[20px] font-semibold tracking-tight text-text-1">
          <LuShieldCheck size={18} className="text-[var(--accent)]" />
          Hedge Vault
        </h1>
        <p className="mt-1 text-[12px] leading-relaxed text-text-3">
          PLP yield minus crash insurance. Most of your deposit earns the vault&apos;s house edge as
          PLP; a small sleeve buys a downside binary that pays if {chosen?.oracle.underlying_asset ?? 'BTC'} drops —
          cushioning PLP&apos;s worst day. One atomic, trustless transaction.
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

        {/* Hedge allocation */}
        <label className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <span className="eyebrow">Crash-insurance sleeve</span>
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
            {fmtQuote(fromQuote(hedgeBudgetBase))} to the hedge · {fmtQuote(fromQuote(supplyBase))} to PLP
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
                {hedge ? `${pct(hedge.otmPct, 1)} OTM` : 'no live market'} ·{' '}
                {chosen ? `expires ${dateUTC(chosen.oracle.expiry)} (${countdown(chosen.oracle.expiry, now)})` : '—'}
              </span>
            </div>
          </div>
          <div className="flex flex-col items-end">
            <span className="eyebrow">Hedge ask</span>
            <span className="text-[13px] text-text-1">
              {askPerContract > 0n ? pct(fromQuote(askPerContract), 1) : '—'}
            </span>
          </div>
        </div>

        {/* Preview */}
        <div className="grid grid-cols-2 gap-2.5">
          <Stat icon={LuLayers} color={HUE.teal} label="Supplied to PLP" value={fmtQuote(fromQuote(supplyBase))} unit={predictConfig.quote.symbol} />
          <Stat icon={LuCoins} color={HUE.amber} label="Hedge cost" value={fmtQuote(fromQuote(hedgeCostBase))} unit={predictConfig.quote.symbol} />
          <Stat icon={LuShieldCheck} color={HUE.blue} label="Hedge size" value={fmtQuote(maxCrashPayout)} unit="contracts" />
          <Stat icon={LuTrendingDown} color={HUE.coral} label="Crash payout" value={fmtQuote(maxCrashPayout)} unit={predictConfig.quote.symbol} />
        </div>

        {hedge && hedgeQty > 0n && (
          <p className="font-sans text-[11px] leading-relaxed text-text-3">
            If {chosen?.oracle.underlying_asset ?? 'BTC'} settles below {price(hedge.strike, 0)}, the hedge
            returns {fmtQuote(maxCrashPayout)} {predictConfig.quote.symbol} — offsetting PLP drawdown. Otherwise it
            expires and the cost is your insurance premium.
          </p>
        )}

        {acct.error && (
          <div className="rounded-lg border border-down/40 bg-down/10 p-2 text-[12px] text-down">{acct.error}</div>
        )}

        <ActionButton reason={reason} busy={acct.busy} onCreate={acct.createManager} onOpen={open} />
      </div>

      <p className="mt-4 text-[10px] leading-relaxed text-text-3">
        Phase 1 · per-user & trustless. Roadmap: a pooled vault issuing a fungible share token, then a
        keeper-run hedge sleeve. Quote asset · {predictConfig.quote.symbol} · {predictConfig.network}.
      </p>
    </div>
  );
}

function ActionButton({
  reason,
  busy,
  onCreate,
  onOpen,
}: {
  reason: string | null;
  busy: string | null;
  onCreate: () => void;
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
  const label: Record<string, string> = {
    connect: 'Connect a wallet',
    'not-deployed': 'Hedge router not deployed on this network',
    'no-oracle': 'No live market to hedge right now',
    'enter-amount': 'Enter a deposit amount',
    insufficient: 'Insufficient DUSDC balance',
    'supply-zero': 'Lower the hedge sleeve',
    pricing: 'Pricing hedge…',
    unquotable: 'Hedge strike not quotable — try again',
    'budget-too-small': 'Increase deposit or hedge %',
    ready: busy === 'open-hedged' ? 'opening position…' : 'Open hedged position',
  };
  const disabled = reason !== 'ready' || !!busy;
  return (
    <button
      onClick={onOpen}
      disabled={disabled}
      className={`h-11 rounded-lg text-[13px] font-semibold transition-all ${
        reason === 'ready'
          ? 'border border-[var(--accent-line)] bg-[var(--accent-soft)] text-up shadow-[0_0_22px_-8px_var(--accent-glow)] hover:bg-up/15'
          : 'border border-line text-text-3'
      } disabled:opacity-60`}
    >
      {label[reason] ?? 'Open hedged position'}
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
