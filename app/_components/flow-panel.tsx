"use client";

/**
 * Trade ticket (Phase 4) — pre-filled by clicking a node on the surface, then
 * runs the real round trip: create_manager → deposit → mint → position → redeem,
 * all on testnet. Account state + tx logic live in `usePredictAccount` (shared
 * with the Portfolio page); this component owns the mint-specific UI. Minting a
 * node pulses a fill ripple back on the surface.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useCurrentClient } from "@mysten/dapp-kit-react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { qk } from "@/lib/api/client";
import { predictConfig } from "@/config/predict";
import { toFloat, fromQuote, toQuote } from "@/config/scale";
import {
  quote as fmtQuote,
  feeAmount,
  price,
  pct,
  signed,
  dateUTC,
  countdown,
} from "@/lib/format";
import { useNow } from "@/lib/hooks/use-now";
import { useMounted } from "@/lib/hooks/use-mounted";
import { useIsEnokiWallet } from "@/lib/hooks/use-is-enoki";
import { useStarterGrant } from "@/lib/hooks/use-starter-grant";
import {
  starterGrant,
  STARTER_GRANT_BALANCE_CEILING,
} from "@/config/starter-grant";
import { useLiveOracleData } from "@/lib/hooks/use-live-oracle-data";
import { usePredictAccount } from "@/lib/hooks/use-predict-account";
import { snapStrikeToTick, gridBounds } from "@/lib/keys";
import {
  quoteMarket,
  solveQuoteForStake,
  type StakeQuote,
} from "@/lib/sui/quote";
import { fundingSplit, feeRouterPayment, skewFee } from "@/lib/sui/funding";
import { humanizeError } from "@/lib/sui/abort";
import { upFair } from "@/lib/svi/svi";
import { buildMintTx, buildMintWithFeeTx } from "@/lib/sui/predict-tx";
import { useSkewFee } from "@/lib/hooks/use-skew-fee";
import { useSurfaceStore } from "@/lib/store/surface-store";
import { RangeTicket } from "./range-ticket";
import { TicketGuide } from "./ticket-guide";
import { TicketEmpty } from "./ticket-empty";
import { MintConfirmModal } from "./mint-confirm-modal";
import { PayoutSlider } from "./ticket/payout-slider";
import { SuccessModal } from "./ui/success-modal";
import { MintSuccessModal } from "./mint-success-modal";
import type { ConfirmRow } from "./mint-confirm-modal";
import { isTradeableFair, type SmileInput } from "@/lib/svi/surface";

const EXPLORER = (digest: string) => `https://suiscan.xyz/testnet/tx/${digest}`;

/** Markets inside this window are about to settle — minting may revert. */
const CLOSING_SOON_MS = 120_000;

/** Hard cutoff: inside the final seconds a sponsored multi-step mint can't
 *  reliably land before expiry, and the quote goes stale fast — block it. */
const MINT_CUTOFF_MS = 5_000;

export function FlowPanel({
  inputs: initialInputs,
  serverNow,
  mobile = false,
  chart,
}: {
  inputs: SmileInput[];
  serverNow: number;
  /** Mobile sheet: land on step 1 (chart + strike) instead of jumping to the bet
   *  step, and render `chart` at the top of step 1. */
  mobile?: boolean;
  chart?: ReactNode;
}) {
  const client = useCurrentClient();
  const now = useNow(serverNow);
  const mounted = useMounted();
  const acct = usePredictAccount();
  // Live oracle set (shared with the table) so a freshly-opened market clicked
  // in the table loads here too — not just the markets present at page load.
  const initialOracles = useMemo(
    () => initialInputs.map((i) => i.oracle),
    [initialInputs],
  );
  const { inputs } = useLiveOracleData(initialOracles, initialInputs);
  const {
    owner,
    managerId,
    dusdcBalance,
    tradingBalanceBase,
    busy,
    error,
    setError,
    lastDigest,
    runTx,
    createManager,
    managerKeys,
  } = acct;

  // True for Google/zkLogin (Enoki) accounts — they're gasless and sponsored.
  const isEnoki = useIsEnokiWallet();

  // One-click "fund my account" — drips DUSDC from the app treasury so a new user
  // never has to leave for the public faucet (and, for EXTERNAL wallets only, a
  // little gas SUI — Google accounts are gasless so they don't need it). Falls
  // back to the faucet link if it's disabled or the grant fails.
  const grant = useStarterGrant(owner, !isEnoki);

  const selection = useSurfaceStore((s) => s.selection);
  const rangeSelection = useSurfaceStore((s) => s.rangeSelection);
  const ticketMode = useSurfaceStore((s) => s.ticketMode);
  const setTicketMode = useSurfaceStore((s) => s.setTicketMode);
  const select = useSurfaceStore((s) => s.select);
  const pulseFill = useSurfaceStore((s) => s.pulseFill);

  // Active oracle = the selection for the current ticket mode, falling back to
  // the other mode's selection. With no selection, default to the soonest expiry
  // that hasn't passed yet — `inputs` is sorted soonest-first and its head can be
  // an expired-but-unsettled market (still `status: active` on the server), so a
  // naive inputs[0] would land the ticket on an expired market. Only if every
  // market is expired (all awaiting settlement) do we fall back to the soonest.
  const active = useMemo(() => {
    const ids =
      ticketMode === "range"
        ? [rangeSelection?.oracleId, selection?.oracleId]
        : [selection?.oracleId, rangeSelection?.oracleId];
    for (const id of ids) {
      if (id) {
        const found = inputs.find((i) => i.oracle.oracle_id === id);
        if (found) return found;
      }
    }
    return inputs.find((i) => i.oracle.expiry > now) ?? inputs[0];
  }, [selection, rangeSelection, ticketMode, inputs, now]);

  // Google/zkLogin (Enoki) mints are gasless and sponsored — no wallet pop-up to
  // review the trade — so gate them behind an explicit in-app confirm (isEnoki is
  // declared above). Normal wallets skip it; their signing prompt is the review.
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Snapshot of the just-minted bet, driving the celebratory success modal that
  // replaces the easy-to-miss toast. Cleared on close.
  const [mintSuccess, setMintSuccess] = useState<{
    headline: string;
    tone: "up" | "down";
    rows: ConfirmRow[];
    staked: string;
    maxWin: string;
    digest: string;
  } | null>(null);

  // Live Skew builder fee (bps). >0 → route the mint through the on-chain fee
  // router so the fee is taken atomically; 0 → plain mint, no fee.
  const { feeBps } = useSkewFee();

  // True while we re-quote the chain right before submitting (between the click
  // and runTx taking over with busy='mint'), so the button can't be double-fired.
  const [preparing, setPreparing] = useState(false);

  // Cost breakdown (skew fee, wallet outflow, funding split, sell-now) is protocol
  // plumbing, not part of the bet decision — collapsed by default so the ticket
  // stays short. Auto-opens when funds are short (see detailsOpen below) so a
  // blocker is never hidden.
  const [showCostDetails, setShowCostDetails] = useState(false);

  const oracle = active?.oracle;
  const forward = active?.forward ?? 0;
  const grid = useMemo(() => (oracle ? gridBounds(oracle) : null), [oracle]);

  const [strike, setStrike] = useState<bigint>(0n);
  const [isUp, setIsUp] = useState(true);
  // Stake as a raw string so the field can be empty / mid-edit (a number-typed
  // input coerces "" → 0, which makes a fresh digit read as "02"). Parsed to a
  // number only where the math needs it (see `betAmount`).
  const [betInput, setBetInput] = useState('1'); // DUSDC the user wants to bet (stake)
  // Two-step guided flow: 1 = side & level, 2 = bet (+ review modal). A fresh
  // surface/table/card pick jumps straight to step 2 (see the selection sync).
  const [step, setStep] = useState<1 | 2>(1);

  // Sync the ticket to the active oracle / latest selection by adjusting state
  // during render (React's documented pattern for "reset state on prop change").
  const selKey =
    selection && oracle && selection.oracleId === oracle.oracle_id
      ? `${selection.strikeScaled}:${selection.isUp}`
      : null;
  const [appliedSel, setAppliedSel] = useState<string | null>(null);
  // Whether the ticket has reconciled with the store at least once this mount.
  // A selection already sitting in the store when we first mount is a leftover
  // from a prior visit (the store is global and survives route changes), NOT a
  // fresh pick — we seed the ticket from it but stay on step 1. Only picks made
  // after we've hydrated advance to the bet step. (Keyed off oracle so a late-
  // loading oracle still hydrates on the render where it first becomes available,
  // not on a possibly oracle-less first render.)
  const [hydrated, setHydrated] = useState(false);
  if (oracle) {
    if (selKey && selKey !== appliedSel) {
      // A genuine external pick (surface / table / card) lands a strike+side the
      // ticket doesn't already show → apply it and skip ahead to the bet step.
      // An internal echo of the ticket's own publish (default strike, +/- nudge,
      // slider drag) already matches local state → record it, but DON'T bounce the
      // user forward or they'd jump to step 2 just by landing / nudging the strike.
      // For this to hold, every ticket-driven strike change must publish to the
      // store synchronously (see `applyStrike` / `setDirection`) — a publish via a
      // passive effect lags local state during a fast drag and looks "external".
      const isExternalPick =
        selection!.strikeScaled !== strike.toString() ||
        selection!.isUp !== isUp;
      setAppliedSel(selKey);
      setStrike(BigInt(selection!.strikeScaled));
      setIsUp(selection!.isUp);
      // Desktop: jump straight to the bet step. Mobile: stay on step 1 so the
      // user sees the price chart + can adjust the strike before betting. Never
      // on the first reconcile — that's a leftover selection, start at step 1.
      if (isExternalPick && !mobile && hydrated) setStep(2);
    } else if (!selKey && strike === 0n) {
      setStrike(snapStrikeToTick(BigInt(Math.round(forward * 1e9)), oracle));
    }
    if (!hydrated) setHydrated(true);
  }

  // Flip UP/DOWN. Mirror the choice into the surface store (not just local state)
  // so the directional win-zone on the 3-D surface swings with the toggle.
  function setDirection(nextUp: boolean) {
    setIsUp(nextUp);
    if (oracle && strike > 0n) {
      select({
        oracleId: oracle.oracle_id,
        expiry: oracle.expiry,
        strikeScaled: strike.toString(),
        strike: toFloat(Number(strike)),
        isUp: nextUp,
      });
      // Mark this selection as already-applied so the render-time sync above
      // treats it as an internal echo (no re-apply, no jump to the bet step).
      setAppliedSel(`${strike.toString()}:${nextUp}`);
    }
  }

  // Change the strike from inside the ticket (slider drag, +/- nudge). Publishes
  // to the surface store SYNCHRONOUSLY — in the same handler that moves the strike,
  // exactly like `setDirection` — and marks it applied. Doing the publish here
  // (rather than only in the passive effect below) is what keeps the store in
  // lockstep with local state during a fast drag: a passive effect runs after
  // paint and lags, so the render-time sync would read a stale store selection,
  // mistake the ticket's own echo for an external pick, and bounce the user to the
  // bet step (snapping the strike back). Keeping it synchronous closes that race.
  function applyStrike(next: bigint) {
    setStrike(next);
    if (oracle && next > 0n) {
      select({
        oracleId: oracle.oracle_id,
        expiry: oracle.expiry,
        strikeScaled: next.toString(),
        strike: toFloat(Number(next)),
        isUp,
      });
      setAppliedSel(`${next.toString()}:${isUp}`);
    }
  }

  // Publish the ticket's working market/strike/side to the surface store so the
  // chart, surface, market table, and odds all highlight what the ticket shows.
  // This now covers only the DEFAULT strike on landing (set during render, with no
  // handler to publish from) — user-driven strike changes publish synchronously via
  // `applyStrike` / `setDirection`, so this effect early-returns for them. Without
  // it the ticket would run on local state only, leaving those views blank until an
  // explicit pick. We omit `source` so it stays an implicit echo (no "From surface"
  // badge). Landing isn't a drag, so there's no lag to mislead the read-back sync.
  useEffect(() => {
    if (!oracle || strike <= 0n || ticketMode !== "binary") return;
    const scaled = strike.toString();
    if (
      selection &&
      selection.oracleId === oracle.oracle_id &&
      selection.strikeScaled === scaled &&
      selection.isUp === isUp
    ) {
      return; // store already matches — nothing to publish
    }
    select({
      oracleId: oracle.oracle_id,
      expiry: oracle.expiry,
      strikeScaled: scaled,
      strike: toFloat(Number(strike)),
      isUp,
    });
  }, [oracle, strike, isUp, ticketMode, selection, select]);

  // The protocol prices the ask as fair + spread, with a ~1% ask floor; deep
  // OTM/ITM strikes round to 0%/100% and can't be priced. We gate on the client
  // fair price with a deliberately wide band (0.2%–99.8%, see FAIR_TRADE_*): a
  // sub-1% fair can still clear the ask floor once the spread lifts it, so we let
  // it through to the chain-authoritative quote rather than pre-blocking it.
  const strikeFloat = toFloat(Number(strike));
  const clientUp =
    oracle && strike > 0n
      ? upFair(strikeFloat, forward, active!.svi, active!.settlement ?? null)
      : null;
  const tradeable = clientUp != null && isTradeableFair(clientUp);

  // Live expiry status — a market at/near expiry will revert on-chain, so we
  // stop quoting and block the mint before the user pays a doomed gas fee.
  const msLeft = oracle ? oracle.expiry - now : 0;
  const expired = !!oracle && msLeft <= 0;
  const closingSoon = !!oracle && msLeft > 0 && msLeft < CLOSING_SOON_MS;
  // Inside the final-seconds cutoff (but not yet expired) — mint is hard-blocked.
  const tooCloseToExpiry = !!oracle && msLeft > 0 && msLeft < MINT_CUTOFF_MS;
  // Single gate for the mint action: past expiry OR inside the cutoff.
  const mintLocked = expired || tooCloseToExpiry;

  // The user bets a dollar amount and pays EXACTLY that: we solve for the
  // position size whose chain cost equals the stake (cost is fixed, the *payout*
  // floats with the odds). On-chain quantity == payout in dollars; the client
  // fair gives a good seed so the solve is one probe + one secant step. Keying
  // the query on the stake (not the solved qty) keeps it stable — the qty the
  // solver returns can't feed back and re-trigger the query.
  const betAmount = Math.max(0, Number(betInput) || 0);
  const stakeBase = toQuote(betAmount);
  const dirFair = clientUp == null ? null : isUp ? clientUp : 1 - clientUp;
  const unitPrice =
    dirFair != null ? Math.min(0.99, Math.max(0.01, dirFair)) : 0.5;
  const qtyGuess = toQuote(betAmount / unitPrice);

  const quoteQ = useQuery({
    queryKey: [
      "quote",
      oracle?.oracle_id,
      strike.toString(),
      isUp,
      stakeBase.toString(),
      owner,
    ],
    queryFn: () =>
      solveQuoteForStake(
        (quantity) =>
          quoteMarket(client.core, {
            sender: owner!,
            oracleId: oracle!.oracle_id,
            expiry: oracle!.expiry,
            strike,
            isUp,
            quantity,
          }),
        stakeBase,
        qtyGuess,
      ),
    enabled:
      !!owner &&
      !!oracle &&
      strike > 0n &&
      stakeBase > 0n &&
      tradeable &&
      !expired,
    // Keep the last quote on screen while a refetch (or a strike/size change) is
    // in flight, so figures update in place instead of blanking the card.
    placeholderData: keepPreviousData,
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
    retry: 0,
  });
  const q: StakeQuote | undefined = tradeable ? quoteQ.data : undefined;

  // The solved position size we actually mint, and its dollar payout ("You win").
  const qtyBase = q?.quantity ?? 0n;
  const payoutDollars = q ? fromQuote(q.quantity) : 0;

  // DUSDC that must come from the connected WALLET for this mint (the manager's
  // free balance covers the rest; this is the buffered figure actually pulled).
  // Same math the "Leaves your wallet now" line shows, hoisted so the button can
  // gate on it.
  const walletOutflow = q
    ? feeBps > 0
      ? feeRouterPayment(q.mintCost, tradingBalanceBase, feeBps).paymentAmount
      : fundingSplit(q.mintCost, tradingBalanceBase).depositAmount
    : 0n;
  // Block the mint when the wallet can't cover its share (balance must be loaded).
  const insufficientFunds =
    !!q && dusdcBalance !== undefined && walletOutflow > dusdcBalance;

  // Open the review modal — the final step for EVERYONE now (it doubles as the
  // in-app preview that gasless Enoki accounts always needed; other wallets then
  // get their signing prompt from handleMint after they confirm here).
  function openReview() {
    if (
      !q ||
      !tradeable ||
      mintLocked ||
      insufficientFunds ||
      busy === "mint" ||
      preparing
    )
      return;
    setConfirmOpen(true);
  }

  async function handleMint() {
    if (!managerId || !q || !oracle || mintLocked || insufficientFunds) return;
    setPreparing(true);
    try {
      // Re-solve against the chain right before submitting. The on-screen quote is
      // polled every ~5s, but the price can move between that and this click (worst
      // near expiry). Re-solving for the stake here keeps the cost pinned to what
      // the user picked at the moment of minting (and the fresh, authoritative cost
      // sizes funding — a stale cost under-funds the deposit and the mint aborts in
      // balance_manager::withdraw).
      let fresh: StakeQuote;
      try {
        fresh = await solveQuoteForStake(
          (quantity) =>
            quoteMarket(client.core, {
              sender: owner!,
              oracleId: oracle.oracle_id,
              expiry: oracle.expiry,
              strike,
              isUp,
              quantity,
            }),
          stakeBase,
          qtyBase > 0n ? qtyBase : qtyGuess,
        );
      } catch {
        setConfirmOpen(false);
        setError(
          "Couldn’t refresh the price — the market may have just moved or expired. Try again.",
        );
        return;
      }
      // With a live builder fee, route through the skew_fee router (fee taken
      // on-chain in the same tx); otherwise the plain deposit+mint path.
      const tx =
        feeBps > 0
          ? buildMintWithFeeTx({
              managerId,
              oracleId: oracle.oracle_id,
              expiry: oracle.expiry,
              strike,
              isUp,
              quantity: fresh.quantity,
              paymentAmount: feeRouterPayment(
                fresh.mintCost,
                tradingBalanceBase,
                feeBps,
              ).paymentAmount,
            })
          : buildMintTx({
              managerId,
              oracleId: oracle.oracle_id,
              expiry: oracle.expiry,
              strike,
              isUp,
              quantity: fresh.quantity,
              depositAmount: fundingSplit(fresh.mintCost, tradingBalanceBase)
                .depositAmount,
            });
      const digest = await runTx(
        "mint",
        tx,
        [...managerKeys, qk.dusdcBalance(owner ?? "")],
        // The success modal below is the celebration — skip the redundant toast.
        { silentSuccess: true },
      );
      setConfirmOpen(false);
      if (digest) {
        pulseFill({
          oracleId: oracle.oracle_id,
          strike: toFloat(Number(strike)),
          isUp,
        });
        // Snapshot the bet (authoritative re-quoted amounts) for the success modal.
        setMintSuccess({
          headline: `${oracle.underlying_asset} · ${isUp ? "UP" : "DOWN"}`,
          tone: isUp ? "up" : "down",
          rows: [
            {
              label: "Outcome",
              value: isUp ? "Pays if price ends ABOVE" : "Pays if price ends BELOW",
            },
            { label: "Strike", value: price(strikeFloat, 0), emphasize: true },
            { label: "Expiry", value: dateUTC(oracle.expiry) },
          ],
          staked: fmtQuote(fromQuote(fresh.mintCost)),
          maxWin: fmtQuote(fromQuote(fresh.quantity)),
          digest,
        });
      }
    } finally {
      setPreparing(false);
    }
  }

  // Until mounted, the connected account is unknown (SSR has no wallet). Render a
  // stable placeholder so the server and first client paint match (no hydration
  // mismatch); the real ticket resolves right after hydration.
  if (!mounted) {
    return <div className="text-[12px] text-text-3">Loading trade ticket…</div>;
  }
  if (!owner) {
    return <TicketEmpty />;
  }
  if (!oracle || !grid) {
    return (
      <div className="text-[12px] text-text-2">
        Waiting for live oracle data…
      </div>
    );
  }

  const sym = predictConfig.quote.symbol;

  // Live step for the first-timer guide. Binary: 3 = reviewing in the modal,
  // 2 = bet step, else 1. Range has no inner step state here, so we advance it
  // from the picked band — step 2 once a band exists for this oracle, else 1.
  const rangeBandPicked =
    !!rangeSelection &&
    !!oracle &&
    rangeSelection.oracleId === oracle.oracle_id;
  const guideStep: 1 | 2 | 3 =
    ticketMode === "range"
      ? rangeBandPicked
        ? 2
        : 1
      : confirmOpen
        ? 3
        : step === 2
          ? 2
          : 1;

  return (
    <div className="flex flex-col gap-4 font-mono text-[12px] tabular-nums">
      {/* Back to step 1 to change the strike (read-only on the bet step). Sits at
          the very top, above the guide, so it's the first thing on the bet step. */}
      {ticketMode === "binary" && step === 2 && (
        <button
          type="button"
          onClick={() => setStep(1)}
          className="-mb-1 inline-flex w-fit items-center gap-1.5 text-[12px] text-text-3 transition-colors hover:text-text-1"
        >
          <span aria-hidden className="text-[14px] leading-none">
            ←
          </span>
          Back to strike
        </button>
      )}

      {/* Plain-language "what do I do here" guide for first-timers (step-aware,
          and mode-aware so range traders aren't told to pick Up/Down). */}
      <TicketGuide step={guideStep} mode={ticketMode} />

      {/* Onboarding actions only — the wallet balance now lives in the top nav
          (BalancePill → Portfolio), freeing the rail. These render only when
          relevant, so an established, funded user starts straight at the trade. */}
      {!managerId && (
        <div className="glass-card flex items-center justify-between gap-2 px-3 py-2.5">
          <span className="text-[12px] text-text-2">
            Create a trading account to start.
          </span>
          <button
            onClick={() => createManager()}
            disabled={busy === "create"}
            className="ctrl-soft shrink-0 rounded-md px-2.5 py-1 text-[11px] text-accent disabled:opacity-50"
          >
            {busy === "create" ? "creating…" : "Create manager"}
          </button>
        </div>
      )}
      {/* Hidden once a grant has succeeded this session (`!grant.success`), so a
          freshly-funded user can't re-tap it and assume they can fund again —
          the balance refetch is async, this hides the CTA immediately. */}
      {dusdcBalance !== undefined &&
        dusdcBalance < STARTER_GRANT_BALANCE_CEILING &&
        !grant.success &&
        (starterGrant.enabled && !grant.failed ? (
          <button
            onClick={grant.claim}
            disabled={grant.busy}
            className="glass-card px-3 py-2 text-left text-[11px] text-accent underline-offset-2 hover:underline disabled:opacity-50"
          >
            {grant.busy
              ? "Funding your account…"
              : `New here? Get ${fmtQuote(fromQuote(starterGrant.displayBase))} ${sym} to start trading →`}
          </button>
        ) : predictConfig.faucetUrl ? (
          <a
            href={predictConfig.faucetUrl}
            target="_blank"
            rel="noreferrer"
            className="glass-card px-3 py-2 text-[11px] text-accent underline-offset-2 hover:underline"
          >
            Low balance — get testnet {sym} →
          </a>
        ) : null)}

      {managerId && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 font-mono text-[11px] tabular-nums text-text-2">
              {oracle.underlying_asset} · {dateUTC(oracle.expiry)} ·{" "}
              <span
                className={expired || closingSoon ? "text-down" : "text-text-3"}
              >
                {expired ? "expired" : `${countdown(oracle.expiry, now)} left`}
              </span>
            </span>
          </div>

          {/* Binary (up/down) vs vertical-range mode. */}
          <div className="flex gap-1.5">
            {(["binary", "range"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setTicketMode(m)}
                aria-pressed={ticketMode === m}
                className={`flex-1 rounded-md py-1.5 text-[11px] font-medium uppercase tracking-wider transition-colors ${
                  ticketMode === m
                    ? "border border-up/40 bg-[var(--accent-soft)] text-accent"
                    : "ctrl-soft text-text-3"
                }`}
              >
                {m === "binary" ? "Up / Down" : "Range"}
              </button>
            ))}
          </div>

          {ticketMode === "range" ? (
            <RangeTicket active={active!} now={now} />
          ) : (
            <>
              <StepBar step={step} onStep={setStep} />

              {step === 1 ? (
                <>
                  {/* Live price of this market (mobile sheet only) — read the movement
              before betting. */}
                  {chart}
                  <div className="flex gap-2">
                    <Toggle
                      active={isUp}
                      onClick={() => setDirection(true)}
                      tone="up"
                    >
                      UP
                    </Toggle>
                    <Toggle
                      active={!isUp}
                      onClick={() => setDirection(false)}
                      tone="down"
                    >
                      DOWN
                    </Toggle>
                  </div>

                  {/* Plain-language explainer so a first-time visitor understands the bet. */}
                  <p className="text-[12px] leading-relaxed text-text-2">
                    Win if{" "}
                    <span className="text-text-1">
                      {oracle.underlying_asset}
                    </span>{" "}
                    settles{" "}
                    <span className={isUp ? "text-up" : "text-down"}>
                      {isUp ? "above" : "below"}{" "}
                      {price(toFloat(Number(strike)))}
                    </span>{" "}
                    at expiry.
                  </p>

                  {/* Strike as a PAYOUT slider — bounded to the quotable band, centered on
              today's price; the exact strike + a $1 nudge live on the slider. */}
                  <PayoutSlider
                    oracle={oracle}
                    forward={forward}
                    svi={active!.svi}
                    settlement={active!.settlement ?? null}
                    isUp={isUp}
                    strike={strike}
                    onChange={applyStrike}
                    disabled={expired}
                  />

                  {!tradeable && !expired && (
                    <p className="text-[12px] leading-relaxed text-text-2">
                      That strike is too far from spot to price — move it nearer{" "}
                      <span className="text-text-1">{price(forward)}</span> to
                      continue.
                    </p>
                  )}

                  <button
                    onClick={() => setStep(2)}
                    disabled={expired || !tradeable}
                    className="group relative flex items-center justify-center gap-2 overflow-hidden rounded-xl border border-white/10 bg-white/4 px-3 py-3.5 text-[13px] font-semibold text-text-1 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07),0_10px_30px_-14px_rgba(0,0,0,0.8)] backdrop-blur-xl transition-all duration-200 hover:border-(--accent-line) hover:text-up hover:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.1),0_0_30px_-8px_var(--accent-glow)] disabled:cursor-not-allowed disabled:border-line disabled:bg-white/2 disabled:text-text-3 disabled:shadow-none disabled:backdrop-blur-none"
                  >
                    {/* top-edge sheen — the glass highlight */}
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-x-6 top-0 h-px bg-linear-to-r from-transparent via-white/20 to-transparent transition-opacity group-hover:via-white/30 group-disabled:opacity-0"
                    />
                    {/* accent wash bloom on hover */}
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-disabled:opacity-0"
                      style={{
                        background:
                          "radial-gradient(120% 120% at 50% 0%, var(--accent-soft), transparent 62%)",
                      }}
                    />
                    <span className="relative">
                      {expired ? "Market expired" : "Set Amount"}
                    </span>
                  </button>
                </>
              ) : (
                <>
                  {/* Entry recap — direction (tap the chip to flip UP/DOWN) and the chosen
              strike (read-only; change it on step 1 via the back arrow up top). */}
                  <div className="glass-inset flex flex-col gap-2.5 rounded-lg p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className={`shrink-0 text-[11px] font-semibold uppercase tracking-wider ${isUp ? "text-up" : "text-down"}`}
                        >
                          {isUp ? "▲ UP" : "▼ DOWN"}
                        </span>
                        <span className="truncate text-[11px] text-text-3">
                          settles {isUp ? "above" : "below"}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setDirection(!isUp)}
                        aria-label={`Switch to ${isUp ? "DOWN" : "UP"}`}
                        className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium uppercase tracking-wider transition-colors ${
                          isUp
                            ? "border-down/30 text-down/70 hover:border-down/50 hover:text-down"
                            : "border-up/30 text-up/70 hover:border-up/50 hover:text-up"
                        }`}
                      >
                        {isUp ? "▼ DOWN" : "▲ UP"}
                      </button>
                    </div>
                    {/* Strike is read-only here — it was set with the slider on step 1.
                Go back to change it (the arrow above), so the level can't be
                accidentally nudged at the bet step. */}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] uppercase tracking-wider text-text-3">
                        Strike
                      </span>
                      <span className="font-mono text-[13px] tabular-nums text-text-1">
                        {price(toFloat(Number(strike)))}
                      </span>
                    </div>
                  </div>

                  {/* Bet size — a plain dollar stake. We translate it to a mintable
              position under the hood; the quote below shows what you pay & win. */}
                  <div className="flex flex-col gap-1.5">
                    <Row label="Bet amount">
                      <div className="ctrl-soft inline-flex items-center gap-1 rounded-md px-2 py-1 focus-within:border-white/20">
                        <input
                          type="text"
                          inputMode="decimal"
                          value={betInput}
                          placeholder="0"
                          onChange={(e) => {
                            const v = e.target.value;
                            // digits + a single optional decimal; empty allowed
                            if (v === "" || /^\d*\.?\d*$/.test(v)) setBetInput(v);
                          }}
                          className="w-16 bg-transparent text-right text-text-1 outline-none"
                          aria-label={`Bet amount in ${sym}`}
                        />
                        <span className="text-[10px] text-text-3">{sym}</span>
                      </div>
                    </Row>
                    <div className="flex gap-1.5">
                      {[1, 5, 10, 25].map((n) => (
                        <button
                          key={n}
                          onClick={() => setBetInput(String(n))}
                          className={`flex-1 rounded-md py-1.5 text-[11px] tabular-nums transition-colors ${
                            Number(betInput) === n
                              ? "border border-up/40 bg-[var(--accent-soft)] text-accent"
                              : "ctrl-soft text-text-3"
                          }`}
                        >
                          ${n}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Risk → Reward: the answer to "what do I pay and what can I win?" */}
                  <div
                    className={`glass-card p-3.5 ${q && tradeable && !expired ? (isUp ? "up glow-accent" : "down glow-down") : ""}`}
                  >
                    {expired ? (
                      <span className="text-text-2">
                        This market has expired and is awaiting settlement —
                        pick another expiry on the surface or in the table.
                      </span>
                    ) : !tradeable ? (
                      <span className="text-text-2">
                        Strike too far from spot to trade — pick one nearer{" "}
                        {price(forward)} (only odds away from the 0%/100%
                        extremes can be priced).
                      </span>
                    ) : !q ? (
                      // Only surface an error / loading state when we have NO quote to
                      // show. A transient devInspect failure during a background refetch
                      // keeps the last good quote on screen rather than flashing red.
                      // While a new quote is in flight (e.g. just changed strike / bet),
                      // show "quoting…" even if the PREVIOUS attempt errored — React
                      // Query holds the stale error until the refetch resolves, and a
                      // flash of "failed to fetch" mid-load reads as a real failure.
                      quoteQ.isError && !quoteQ.isFetching ? (
                        <span className="text-down">
                          {humanizeError(quoteQ.error)}
                        </span>
                      ) : (
                        <span className="text-text-3">quoting…</span>
                      )
                    ) : (
                      (() => {
                        const cost = fromQuote(q.mintCost);
                        const maxPayout = payoutDollars; // what you win if the bet is right
                        const chance =
                          Number((q.mintCost * 1_000_000_000n) / qtyBase) / 1e9;
                        // Skew builder fee (on top of the bet) + funding. With a fee, the
                        // router takes a single payment coin (fee + deposit); without one,
                        // mint pays from the manager free balance first and only the
                        // shortfall is pulled from the wallet now.
                        const router = feeRouterPayment(
                          q.mintCost,
                          tradingBalanceBase,
                          feeBps,
                        );
                        const feeF = fromQuote(router.fee);
                        const profit = maxPayout - cost - feeF; // net of the Skew fee too
                        const mult =
                          cost + feeF > 0 ? maxPayout / (cost + feeF) : 0;
                        const walletNow = walletOutflow; // hoisted above (same math)
                        // Keep the breakdown collapsed normally, but force it open when the
                        // wallet can't cover its share — that warning must never be hidden.
                        const detailsOpen =
                          showCostDetails || insufficientFunds;
                        return (
                          <div className="flex flex-col">
                            <div className="grid grid-cols-2 gap-3">
                              <div className="flex flex-col gap-1.5">
                                <span className="eyebrow">You pay</span>
                                <span className="flex items-baseline gap-1.5">
                                  <span className="text-[22px] leading-none text-text-1">
                                    {fmtQuote(cost)}
                                  </span>
                                  <span className="text-[11px] leading-none text-text-3">
                                    {sym}
                                  </span>
                                </span>
                              </div>
                              <div className="flex flex-col gap-1.5">
                                <span className="eyebrow">You win</span>
                                <span className="flex items-baseline gap-1.5">
                                  <span className="text-[22px] leading-none text-up">
                                    {fmtQuote(maxPayout)}
                                  </span>
                                  <span className="text-[11px] leading-none text-text-3">
                                    {sym}
                                  </span>
                                  <span className="rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] leading-none text-up">
                                    {mult.toFixed(2)}×
                                  </span>
                                </span>
                              </div>
                            </div>
                            <span className="mt-2 text-[10px] text-text-3">
                              net profit if right{" "}
                              <span className="text-up">{signed(profit)}</span>
                            </span>

                            <div className="mt-3 flex flex-col gap-1.5">
                              <div className="flex items-center justify-between">
                                <span className="eyebrow">Implied chance</span>
                                <span className="text-[12px] tabular-nums text-text-2">
                                  {pct(chance, 1)}
                                </span>
                              </div>
                              <div className="meter">
                                <i
                                  style={{
                                    width: `${Math.min(100, Math.max(0, chance * 100))}%`,
                                    background: isUp
                                      ? "var(--up)"
                                      : "var(--down)",
                                  }}
                                />
                              </div>
                            </div>

                            <button
                              type="button"
                              onClick={() => setShowCostDetails((v) => !v)}
                              aria-expanded={detailsOpen}
                              className="mt-3 flex items-center justify-between rounded-md px-1 py-1 text-[11px] text-text-3 transition-colors hover:text-text-2"
                            >
                              <span>Cost details</span>
                              <span className="tabular-nums text-text-3">
                                {detailsOpen ? "−" : "+"}
                              </span>
                            </button>
                            {detailsOpen && (
                              <div className="glass-inset mt-1 flex flex-col gap-2 p-3">
                                {feeBps > 0 && (
                                  <>
                                    <div className="flex items-center justify-between">
                                      <span className="text-[11px] text-text-3">
                                        Skew fee · {(feeBps / 100).toFixed(2)}%
                                      </span>
                                      <span className="text-[11px] tabular-nums text-text-1">
                                        +{feeAmount(feeF)} {sym}
                                      </span>
                                    </div>
                                    <span className="text-[10px] leading-relaxed text-text-3">
                                      Bet cost goes to the DeepBook Predict
                                      vault; the Skew fee goes to Skew.
                                    </span>
                                  </>
                                )}
                                {/* What actually leaves the wallet now — reconciles the total
                          cost above with the smaller "coin outflow" the wallet shows,
                          since the manager's free balance funds the rest. */}
                                <div className="flex items-center justify-between">
                                  <span className="text-[11px] text-text-3">
                                    Leaves your wallet now
                                  </span>
                                  <span
                                    className={`text-[11px] tabular-nums ${insufficientFunds ? "text-down" : "text-text-1"}`}
                                  >
                                    {walletNow > 0n ? "≈ " : ""}
                                    {fmtQuote(fromQuote(walletNow))} {sym}
                                  </span>
                                </div>
                                {insufficientFunds && (
                                  <span className="text-[10px] leading-relaxed text-down">
                                    That’s more than your{" "}
                                    {fmtQuote(fromQuote(dusdcBalance ?? 0n))}{" "}
                                    {sym} wallet balance — add {sym} or lower
                                    your bet.
                                  </span>
                                )}
                                {walletNow > 0n && tradingBalanceBase > 0n ? (
                                  <span className="text-[10px] leading-relaxed text-text-3">
                                    The rest of the {fmtQuote(cost)} {sym} cost
                                    is covered by your{" "}
                                    {fmtQuote(fromQuote(tradingBalanceBase))}{" "}
                                    {sym} trading account balance.
                                  </span>
                                ) : walletNow === 0n ? (
                                  <span className="text-[10px] leading-relaxed text-text-3">
                                    Fully covered by your trading account
                                    balance — nothing new is pulled from your
                                    wallet.
                                  </span>
                                ) : null}
                                <div className="flex items-center justify-between">
                                  <span className="text-[11px] text-text-3">
                                    Sell now
                                  </span>
                                  <span className="text-[11px] tabular-nums text-text-2">
                                    {fmtQuote(fromQuote(q.redeemPayout))} {sym}
                                  </span>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })()
                    )}
                  </div>

                  {/* Near-expiry caution — the failure mode the user just hit. Inside the
              final-seconds cutoff the mint is blocked outright (tooCloseToExpiry). */}
                  {closingSoon && !expired && (
                    <div className="rounded border border-down/40 bg-down/10 p-2 text-[11px] leading-relaxed text-down">
                      {tooCloseToExpiry
                        ? "Too close to expiry to mint — a transaction can’t land in time. Pick another expiry."
                        : `Closing in ${countdown(oracle.expiry, now)} — a mint may revert if the market settles before your transaction lands on-chain.`}
                    </div>
                  )}

                  <button
                    onClick={openReview}
                    disabled={
                      !q ||
                      !tradeable ||
                      mintLocked ||
                      insufficientFunds ||
                      busy === "mint" ||
                      preparing
                    }
                    className={`group relative flex items-center justify-center gap-2 overflow-hidden rounded-lg border bg-linear-to-b px-3 py-3 text-[13px] font-semibold transition-all disabled:cursor-not-allowed disabled:border-line disabled:from-transparent disabled:to-transparent disabled:text-text-3 disabled:shadow-none ${
                      isUp
                        ? "border-up/50 from-up/25 to-up/10 text-up shadow-[0_0_24px_-6px_var(--accent-glow)] hover:from-up/35 hover:to-up/15 hover:shadow-[0_0_30px_-4px_var(--accent-glow)]"
                        : "border-down/50 from-down/25 to-down/10 text-down shadow-[0_0_24px_-6px_rgba(240,121,107,0.3)] hover:from-down/35 hover:to-down/15 hover:shadow-[0_0_30px_-4px_rgba(240,121,107,0.34)]"
                    }`}
                  >
                    {expired
                      ? "Market expired"
                      : tooCloseToExpiry
                        ? "Too close to expiry"
                        : insufficientFunds
                          ? `Insufficient ${sym} — need ${fmtQuote(fromQuote(walletOutflow))}`
                          : q
                            ? `Review`
                            : "Review bet"}
                  </button>

                  <p className="text-[10px] leading-relaxed text-text-3">
                    You’ll preview the trade next; the final price is confirmed
                    on-chain when you sign and can revert if the market moves or
                    expires first.
                  </p>
                </>
              )}

              {q && (
                <MintConfirmModal
                  open={confirmOpen}
                  onClose={() => setConfirmOpen(false)}
                  onConfirm={handleMint}
                  busy={busy === "mint" || preparing}
                  headline={`${oracle.underlying_asset} · ${isUp ? "UP" : "DOWN"}`}
                  tone={isUp ? "up" : "down"}
                  rows={[
                    {
                      label: "Outcome",
                      value: isUp
                        ? "Pays if price ends ABOVE"
                        : "Pays if price ends BELOW",
                    },
                    {
                      label: "Strike",
                      value: price(strikeFloat, 0),
                      emphasize: true,
                    },
                    {
                      label: "Expiry",
                      value: `${dateUTC(oracle.expiry)} · ${countdown(oracle.expiry, now)}`,
                    },
                    ...(feeBps > 0
                      ? [
                          {
                            label: `Skew fee (${(feeBps / 100).toFixed(2)}%)`,
                            value: `${feeAmount(fromQuote(skewFee(q.mintCost, feeBps)))} ${sym}`,
                          },
                        ]
                      : []),
                  ]}
                  cost={fmtQuote(fromQuote(q.mintCost))}
                  maxWin={fmtQuote(payoutDollars)}
                  confirmLabel={`Mint ${isUp ? "UP" : "DOWN"}`}
                />
              )}
            </>
          )}
        </div>
      )}

      {error && (
        <div className="rounded border border-down/40 bg-down/10 p-2 text-down">
          {error}
        </div>
      )}
      {lastDigest && (
        <a
          href={EXPLORER(lastDigest)}
          target="_blank"
          rel="noreferrer"
          className="text-[10px] text-text-3 underline hover:text-text-2"
        >
          last tx: {lastDigest.slice(0, 12)}… ↗
        </a>
      )}

      {/* Animated confirmation that the starter grant landed — a toast alone is
          easy to miss for this gasless flow. */}
      <SuccessModal
        open={!!grant.success}
        onClose={grant.clearSuccess}
        title="Account funded"
        eyebrow="Received"
        amount={grant.success?.amount ?? 0}
        sub="added to your wallet — you’re ready to trade"
        gasNote={
          grant.success?.sui
            ? `+ ${grant.success.sui} SUI added for gas`
            : undefined
        }
        digest={grant.success?.digest}
      />

      {/* Celebratory confirmation that the bet landed (replaces the toast). */}
      {mintSuccess && (
        <MintSuccessModal
          open={!!mintSuccess}
          onClose={() => setMintSuccess(null)}
          headline={mintSuccess.headline}
          tone={mintSuccess.tone}
          rows={mintSuccess.rows}
          staked={mintSuccess.staked}
          maxWin={mintSuccess.maxWin}
          digest={mintSuccess.digest}
        />
      )}
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-3">{label}</span>
      <span className="text-text-1">{children}</span>
    </div>
  );
}

/** Compact two-step progress for the guided binary flow. Each segment is a
 *  back-nav target: step 1 is always reachable, step 2 only once you've advanced. */
function StepBar({
  step,
  onStep,
}: {
  step: 1 | 2;
  onStep: (s: 1 | 2) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <StepSeg
        n={1}
        label="Side & level"
        active={step === 1}
        done={step > 1}
        onClick={() => onStep(1)}
        clickable
      />
      <span
        className={`h-px flex-1 transition-colors ${step > 1 ? "bg-accent/40" : "bg-line"}`}
      />
      <StepSeg
        n={2}
        label="Your bet"
        active={step === 2}
        done={false}
        onClick={() => onStep(2)}
        clickable={step >= 2}
      />
    </div>
  );
}

function StepSeg({
  n,
  label,
  active,
  done,
  onClick,
  clickable,
}: {
  n: number;
  label: string;
  active: boolean;
  done: boolean;
  onClick: () => void;
  clickable: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      aria-current={active ? "step" : undefined}
      className={`flex items-center gap-1.5 text-[10px] uppercase tracking-wider transition-colors disabled:cursor-default ${
        active
          ? "text-text-1"
          : clickable
            ? "text-text-3 hover:text-text-2"
            : "text-text-3"
      }`}
    >
      <span
        className={`flex h-5 w-5 items-center justify-center rounded-full border text-[10px] tabular-nums ${
          active
            ? "border-accent/60 bg-[var(--accent-soft)] text-accent"
            : done
              ? "border-accent/40 text-accent"
              : "border-line text-text-3"
        }`}
      >
        {done ? "✓" : n}
      </span>
      {label}
    </button>
  );
}

function Toggle({
  active,
  onClick,
  tone,
  children,
}: {
  active: boolean;
  onClick: () => void;
  tone: "up" | "down";
  children: React.ReactNode;
}) {
  const glyph = tone === "up" ? "▲" : "▼";
  const activeCls =
    tone === "up"
      ? "border border-up/50 bg-[var(--accent-soft)] text-up shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06),0_0_22px_-8px_var(--accent-glow)]"
      : "border border-down/50 bg-[var(--down-soft)] text-down shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06),0_0_22px_-8px_rgba(240,121,107,0.3)]";
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2.5 text-[13px] font-semibold tracking-wide transition-all ${
        active ? activeCls : "ctrl-soft text-text-3"
      }`}
    >
      <span className="text-[9px]">{glyph}</span>
      {children}
    </button>
  );
}
