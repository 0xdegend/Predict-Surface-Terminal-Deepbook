'use client';

/**
 * usePredictAccountV2 — the trader's on-chain account for the NEW deployment.
 *
 * Custody is the account package (AccountWrapper + Auth + AccumulatorRoot), so
 * there's no manager/server lookup — the wrapper address is derived on-chain and
 * its balance read by simulate. Mirrors the legacy runTx (incl. Enoki gasless
 * sponsorship + finalized-status check) so signing UX stays identical. Used by
 * the v2 trade ticket; portfolio/order listing arrives with the indexer (Phase 3).
 */
import { useState } from 'react';
import { useCurrentAccount, useCurrentWallet } from '@mysten/dapp-kit-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Transaction, SerialTransactionExecutor } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { useV2ReadClient } from '@/lib/sui/grpc';
import { isEnokiWallet } from '@mysten/enoki';
import { predictV2Config, V2_SESSIONS_ENABLED } from '@/config/predict';
import { enokiEnabled } from '@/config/enoki';
import { dAppKit } from '@/lib/sui/dapp-kit';
import { executeSponsored, sponsorshipAvailable } from '@/lib/sui/enoki-sponsor';
import { humanizeV2Error } from '@/lib/sui/v2/abort';
import { isSessionExpired, SESSION_EXPIRED_MESSAGE } from '@/lib/sui/abort';
import { toast } from '@/lib/store/toast-store';
import { readWrapper, readAccountId, readBalance, buildCreateAccountTx, buildDepositTx, buildWithdrawTx, buildCashOutTx } from '@/lib/sui/v2/account';
import { buildMintTx, buildMintBudgetTx, buildRedeemLiveTx, buildRedeemSettledTx, type MintParams, type MintBudgetParams, type RedeemParams } from '@/lib/sui/v2/predict-tx';
import {
  buildSessionMintTx,
  buildSessionMintBudgetTx,
  buildSessionRedeemLiveTx,
  buildSessionRedeemSettledTx,
} from '@/lib/sui/v2/session-tx';
import {
  loadSession,
  saveSession,
  clearSession,
  generateSession,
  readSessionExpiry,
  isSessionLive,
  buildAuthorizeSessionTx,
  buildRevokeSessionTx,
  buildSweepSessionGasTx,
  addAuthorizeSession,
  SUI_TYPE,
  SESSION_SWEEP_DUST_MIST,
  SESSION_GAS_BUDGET,
  SESSION_DURATIONS_MS,
  DEFAULT_SESSION_DURATION,
  DEFAULT_SESSION_GAS_FUNDING_BASE,
  type SessionDuration,
  type LoadedSession,
} from '@/lib/sui/v2/session';
import { dripSessionGas } from '@/lib/sui/v2/session-gas';
import { sessionGasDrip } from '@/config/session-gas';
import { qkV2 } from '@/lib/api/v2/client';
import { useBuilderCode, qkBuilderCode } from '@/lib/hooks/use-builder-code';
import { qkLpQueue } from '@/lib/hooks/use-lp-queue';
import {
  buildRequestSupplyTx,
  buildRequestWithdrawTx,
  buildCancelSupplyTx,
  buildCancelWithdrawTx,
} from '@/lib/sui/v2/plp';

export const qkV2Account = {
  wrapper: (owner: string) => ['v2', 'wrapper', owner] as const,
  accountId: (wrapperId: string) => ['v2', 'account-id', wrapperId] as const,
  balance: (wrapperId: string) => ['v2', 'balance', wrapperId] as const,
  plpBalance: (wrapperId: string) => ['v2', 'plp-balance', wrapperId] as const,
  walletDusdc: (owner: string) => ['v2', 'wallet-dusdc', owner] as const,
  sessionLocal: (owner: string) => ['v2', 'session-local', owner] as const,
  sessionExpiry: (wrapperId: string, sessionAddr: string) =>
    ['v2', 'session-expiry', wrapperId, sessionAddr] as const,
  sessionGas: (sessionAddr: string) => ['v2', 'session-gas', sessionAddr] as const,
};

/** Options for a mint. `startSession` bundles "turn on instant trading" into this
 *  trade's owner-signed approval (only honored when no session is live yet). */
type TradeOpts = { silentSuccess?: boolean; startSession?: { duration: SessionDuration } };

/* ---- Phase 3: fast session submit --------------------------------------- */
// ONE SerialTransactionExecutor per (session address, gRPC client), shared across all
// hook instances — two executors on the same gas coin would fight over its version. It
// caches object refs + the gas coin and carries a fixed gas budget, so a warm session
// trade builds offline and submits in a single call with NO dry-run gas estimation.
// Rebuilt on a session or client (health-failover) change; reset on end/expiry/failure.
let sessionExecutor: { address: string; client: SuiGrpcClient; executor: SerialTransactionExecutor } | null = null;

function getSessionExecutor(loaded: LoadedSession, client: SuiGrpcClient): SerialTransactionExecutor {
  if (sessionExecutor && sessionExecutor.address === loaded.address && sessionExecutor.client === client) {
    return sessionExecutor.executor;
  }
  const executor = new SerialTransactionExecutor({ client, signer: loaded.signer, defaultGasBudget: SESSION_GAS_BUDGET });
  sessionExecutor = { address: loaded.address, client, executor };
  return executor;
}

function resetSessionExecutor(): void {
  sessionExecutor = null;
}

export function usePredictAccountV2() {
  const account = useCurrentAccount();
  // Health-aware gRPC client (not the wallet's session-pinned client): balance
  // reads, tx build/execute, and confirmation all follow the endpoint failover, so
  // a stalled primary fullnode can't strand the account or block trades.
  const client = useV2ReadClient();
  const currentWallet = useCurrentWallet();
  const queryClient = useQueryClient();
  const owner = account?.address;

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const gasless =
    enokiEnabled && !!currentWallet && isEnokiWallet(currentWallet) && sponsorshipAvailable;

  // Wrapper address + existence (derived on-chain via simulate).
  const wrapperQ = useQuery({
    queryKey: qkV2Account.wrapper(owner ?? ''),
    queryFn: () => readWrapper(client.core, owner!),
    enabled: !!owner,
    refetchInterval: 15_000,
  });
  const wrapperId = wrapperQ.data?.wrapperId;
  const wrapperExists = wrapperQ.data?.exists ?? false;

  // The internal account id — the key the indexer files positions/orders under
  // (NOT the wallet owner, NOT the wrapper object). Resolved on-chain from the
  // wrapper; stable, so cache it long.
  const accountIdQ = useQuery({
    queryKey: qkV2Account.accountId(wrapperId ?? ''),
    queryFn: () => readAccountId(client.core, wrapperId!),
    enabled: !!wrapperId && wrapperExists,
    staleTime: Infinity,
  });
  const accountId = accountIdQ.data;

  // Free DUSDC balance in the account (base units).
  const balanceQ = useQuery({
    queryKey: qkV2Account.balance(wrapperId ?? ''),
    queryFn: () => readBalance(client.core, wrapperId!),
    enabled: !!wrapperId && wrapperExists,
    refetchInterval: 10_000,
  });
  const balanceBase = balanceQ.data ?? 0n;

  // Custodied PLP shares (vault liquidity held in the account, base units).
  const plpQ = useQuery({
    queryKey: qkV2Account.plpBalance(wrapperId ?? ''),
    queryFn: () => readBalance(client.core, wrapperId!, predictV2Config.plpCoinType),
    enabled: !!wrapperId && wrapperExists,
    refetchInterval: 10_000,
  });
  const plpBalanceBase = plpQ.data ?? 0n;

  // ---- Delegated trading sessions ([[sessions-delegated-trading]]) — Phase 1: lifecycle.
  // The local session key on THIS device (null if none). Gated behind the dark flag so
  // nothing runs on deployments without the package or until we turn it on.
  const sessionLocalQ = useQuery({
    queryKey: qkV2Account.sessionLocal(owner ?? ''),
    queryFn: () => loadSession(owner!),
    enabled: V2_SESSIONS_ENABLED && !!owner,
    staleTime: Infinity,
  });
  const localSession = sessionLocalQ.data ?? null;

  // The session's ON-CHAIN expiry — the source of truth for "is it live" (a local key
  // may have expired or been revoked). Re-read periodically so the UI reflects lapse.
  const sessionExpiryQ = useQuery({
    queryKey: qkV2Account.sessionExpiry(wrapperId ?? '', localSession?.address ?? ''),
    queryFn: () => readSessionExpiry(client.core, wrapperId!, localSession!.address),
    enabled: V2_SESSIONS_ENABLED && !!wrapperId && wrapperExists && !!localSession,
    refetchInterval: 30_000,
  });
  const sessionExpiryMs = sessionExpiryQ.data ?? null;
  const sessionLive = isSessionLive(sessionExpiryMs);

  // The session key's own SUI (gas) balance — powers the "your session still has gas,
  // no SUI needed this time" note when re-arming, lets the bundle top up only the
  // difference, and gates a GASLESS session on being funded (below). Only read when a
  // local key exists.
  const sessionGasQ = useQuery({
    queryKey: qkV2Account.sessionGas(localSession?.address ?? ''),
    queryFn: () => readSessionSui(localSession!.address),
    enabled: V2_SESSIONS_ENABLED && !!localSession,
    refetchInterval: 30_000,
  });
  const sessionGasBase = sessionGasQ.data ?? 0n;

  // A session carries a trade for a live, locally-held key, and it is a LATENCY win for
  // everyone: for SLUSH it removes the per-trade wallet popup; for GASLESS (Google) it
  // removes the Enoki sponsor round-trips + dry-run — the session key signs locally and
  // submits in one call. A gasless key can only self-fund its gas once the treasury drip
  // has landed, so gasless counts as active only when the key actually holds gas.
  const sessionFunded = sessionGasBase >= SESSION_GAS_BUDGET;
  const sessionActive =
    V2_SESSIONS_ENABLED && sessionLive && !!localSession && (!gasless || sessionFunded);

  /** Read the SUI (MIST) balance of a session key's address. Non-throwing (0 on error). */
  async function readSessionSui(addr: string): Promise<bigint> {
    try {
      const r = await client.core.getBalance({ owner: addr, coinType: SUI_TYPE });
      return BigInt(r.balance.balance);
    } catch {
      return 0n;
    }
  }

  // Builder-fee attribution. The protocol pays the add-on builder fee to the code
  // carried by the ACCOUNT, not by the transaction — so a trade placed here earns
  // us nothing unless this account is attributed to us. We ride the attach along
  // inside the mint PTB (no second signature), and only when the slot is empty.
  const builderCode = useBuilderCode(wrapperId);

  // DUSDC still in the connected wallet (outside the trading account).
  const walletDusdcQ = useQuery({
    queryKey: qkV2Account.walletDusdc(owner ?? ''),
    queryFn: async () => {
      const r = await client.core.getBalance({ owner: owner!, coinType: predictV2Config.quote.coinType });
      return BigInt(r.balance.balance);
    },
    enabled: !!owner,
    refetchInterval: 10_000,
  });

  async function runTx(
    label: string,
    tx: Transaction,
    invalidate: readonly (readonly unknown[])[] = [],
    opts?: { silentSuccess?: boolean; allowedAddresses?: string[] },
  ) {
    if (!owner) return null;
    setBusy(label);
    setError(null);
    try {
      let digest: string;
      if (gasless) {
        // `allowedAddresses` lets a sponsored tx touch an external address (a
        // cash-out destination); Enoki rejects transfers to un-allowlisted
        // addresses otherwise. Undefined for normal in-account flows.
        digest = await executeSponsored(tx, owner, opts?.allowedAddresses);
      } else {
        // BUILD + EXECUTE via our own health-aware gRPC client so a stalled primary
        // fullnode can't block trades: object refs + gas resolve on a synced node, the
        // wallet signs the fully-built bytes (no re-resolution against its own pinned
        // client), and we execute on the synced node. Sign-only (not signAndExecute)
        // also dodges a dapp-kit crash that re-parses the wallet response and throws
        // AFTER the tx already landed (Slush 2026-07-08).
        tx.setSenderIfNotSet(owner);
        const built = await tx.build({ client });
        const { bytes, signature } = await dAppKit.signTransaction({ transaction: Transaction.from(built) });
        const result = await client.core.executeTransaction({
          transaction: fromBase64(bytes),
          signatures: [signature],
        });
        if (result.$kind === 'FailedTransaction') {
          throw new Error(result.FailedTransaction.status?.error?.message ?? 'Transaction failed on-chain');
        }
        digest = result.Transaction.digest;
      }
      const confirmed = await client.core.waitForTransaction({ digest });
      if (confirmed.$kind === 'FailedTransaction') {
        throw new Error(confirmed.FailedTransaction.status?.error?.message ?? 'Transaction aborted on-chain');
      }
      await new Promise((r) => setTimeout(r, 1200));
      for (const key of invalidate) await queryClient.invalidateQueries({ queryKey: key });
      await queryClient.invalidateQueries({ queryKey: qkV2Account.wrapper(owner) });
      if (!opts?.silentSuccess) {
        toast.success('Done', { desc: `${digest.slice(0, 14)}…`, href: `https://suiscan.xyz/${predictV2Config.network}/tx/${digest}` });
      }
      return digest;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (gasless && (isSessionExpired(e) || /popup|window closed|Failed to open/i.test(msg))) {
        setError(SESSION_EXPIRED_MESSAGE);
        return null;
      }
      setError(humanizeV2Error(e));
      toast.error('Transaction failed', { desc: humanizeV2Error(e) });
      return null;
    } finally {
      setBusy(null);
    }
  }

  /**
   * Run a trade signed by the SESSION key — no wallet popup at all. The session
   * key is the sender AND pays its own gas (funded a little SUI at authorize), so
   * this never touches dApp-kit or the Enoki sponsor. It can only ever call the
   * four `sessions::*` trade wrappers, so the blast radius is the same as the
   * owner path minus deposits/withdrawals/attribution. Mirrors `runTx`'s confirm +
   * invalidate + toast tail so success/UX is identical to a normal trade.
   */
  async function runSessionTx(
    label: string,
    tx: Transaction,
    invalidate: readonly (readonly unknown[])[] = [],
    opts?: { silentSuccess?: boolean },
  ) {
    if (!owner) return null;
    const loaded = await loadSession(owner);
    if (!loaded) {
      // The key vanished (cleared/other device) — fall back to nothing; the caller's
      // gate should prevent this, but never sign blind.
      setError('Your trading session is not available on this device. Start a new session.');
      return null;
    }
    setBusy(label);
    setError(null);
    try {
      // Phase 3 fast submit: the shared per-session executor builds with cached object
      // refs + gas coin and a fixed gas budget, so a warm trade skips the dry-run gas
      // estimation and lands in one call. It submits EXACTLY once and self-resets its
      // cache on failure — we never auto-retry, because a mint is not idempotent and an
      // ambiguous failure could otherwise double-mint.
      const result = await getSessionExecutor(loaded, client).executeTransaction(tx, { effects: true });
      if (result.$kind === 'FailedTransaction') {
        throw new Error(result.FailedTransaction.status?.error?.message ?? 'Transaction failed on-chain');
      }
      const digest = result.Transaction.digest;
      const confirmed = await client.core.waitForTransaction({ digest });
      if (confirmed.$kind === 'FailedTransaction') {
        throw new Error(confirmed.FailedTransaction.status?.error?.message ?? 'Transaction aborted on-chain');
      }
      await new Promise((r) => setTimeout(r, 1200));
      for (const key of invalidate) await queryClient.invalidateQueries({ queryKey: key });
      await queryClient.invalidateQueries({ queryKey: qkV2Account.wrapper(owner) });
      if (!opts?.silentSuccess) {
        toast.success('Done', { desc: `${digest.slice(0, 14)}…`, href: `https://suiscan.xyz/${predictV2Config.network}/tx/${digest}` });
      }
      return digest;
    } catch (e) {
      // Drop the executor so the next attempt re-warms from a clean cache (a build-stage
      // failure doesn't self-reset inside the executor).
      resetSessionExecutor();
      setError(humanizeV2Error(e));
      toast.error('Trade failed', { desc: humanizeV2Error(e) });
      return null;
    } finally {
      setBusy(null);
    }
  }

  // Closing a position reduces the lot and pays proceeds into the account —
  // refresh the position list (filed under the indexer account key) and the
  // free balance so a partial close visibly draws down and the payout lands.
  const redeemInvalidations: readonly (readonly unknown[])[] = [
    ...(accountId ? [qkV2.accountPositions(accountId)] : []),
    ...(wrapperId ? [qkV2Account.balance(wrapperId)] : []),
  ];

  // Refresh the freshly minted bet everywhere it shows. Positions and orders are
  // filed under the internal ACCOUNT id, NOT the wallet owner (see use-v2-positions)
  // — invalidating the owner key was a no-op, so a new position only surfaced on the
  // 12s poll or a manual reload. Use the account id (matching the redeem path above)
  // plus the order log that backs history + the cost-basis join. A mint may also have
  // carried a `set_builder_code`, so re-read the attachment too.
  const mintInvalidations: readonly (readonly unknown[])[] = [
    ...(accountId ? [qkV2.accountPositions(accountId), qkV2.accountOrders(accountId)] : []),
    ...(wrapperId ? [qkBuilderCode.attached(wrapperId), qkV2Account.balance(wrapperId)] : []),
  ];

  // Every LP action (queue a deposit/withdrawal, or cancel one) moves money
  // between the account and the vault's escrow, so the queue table and both
  // balances have to re-read — otherwise a cancel appears to do nothing until
  // the next poll.
  const vaultInvalidations: readonly (readonly unknown[])[] = [
    qkLpQueue.all,
    ...(wrapperId ? [qkV2Account.balance(wrapperId), qkV2Account.plpBalance(wrapperId)] : []),
  ];

  /**
   * Ensure a session key will have gas, and return how much SUI the AUTHORIZE tx must
   * itself transfer to it (undefined = none needed in-tx). Prefers the app treasury
   * drip — a separate server tx that covers BOTH Google (who hold no SUI) and Slush
   * (so neither spends their own) — and falls back to an owner-funded top-up for Slush
   * when the drip is off or unavailable. A key that already holds the target (a re-arm
   * after expiry with leftover gas) needs nothing.
   */
  async function resolveSessionGasFunding(sessionAddress: string): Promise<bigint | undefined> {
    const have = await readSessionSui(sessionAddress);
    const target = DEFAULT_SESSION_GAS_FUNDING_BASE;
    if (have >= target) return undefined;
    if (sessionGasDrip.enabled) {
      const drip = await dripSessionGas(sessionAddress);
      if (drip.ok) {
        // Treasury funded the key directly; reflect it so the gate can flip.
        void queryClient.invalidateQueries({ queryKey: qkV2Account.sessionGas(sessionAddress) });
        return undefined;
      }
    }
    // Drip off/failed: Slush tops up from its own SUI inside the authorize tx; a gasless
    // key can't self-fund, so leave it unfunded (the session just won't go active, and
    // this trade still lands via the normal path — no broken state, retry re-drips).
    return gasless ? undefined : target - have;
  }

  /**
   * Append `authorize_session` (+ any needed gas) to the trader's FIRST trade tx, so
   * instant trading turns on inside the SAME action as that trade (no separate step).
   * Works for both paths: a Slush owner signs it in their trade popup; a Google user's
   * sponsored trade carries it silently. Gas is handled by resolveSessionGasFunding
   * (treasury drip first, owner top-up as the Slush fallback). Returns the session
   * address (for cache invalidation), or null if it couldn't be set up. Mutates `tx`.
   */
  async function bundleSessionInto(tx: Transaction, duration: SessionDuration): Promise<string | null> {
    if (!owner || !wrapperId) return null;
    let sessionAddress = (await loadSession(owner))?.address;
    if (!sessionAddress) sessionAddress = (await saveSession(owner, await generateSession())).address;
    const gasFundingBase = await resolveSessionGasFunding(sessionAddress);
    addAuthorizeSession(tx, { wrapperId, sessionAddress, durationMs: SESSION_DURATIONS_MS[duration], gasFundingBase });
    return sessionAddress;
  }

  /**
   * The wallet-signed (Slush) or sponsored (Google) mint, optionally bundling "turn on
   * instant trading" into the SAME action when the caller armed it and no session is
   * live yet. Shared by mint + mintBudget. Extends the invalidations so the session
   * pill/state flip on right after.
   */
  async function runOwnerMint(tx: Transaction, opts?: TradeOpts): Promise<string | null> {
    let invalidations = mintInvalidations;
    if (opts?.startSession && !sessionActive && V2_SESSIONS_ENABLED && owner && wrapperId) {
      const addr = await bundleSessionInto(tx, opts.startSession.duration);
      if (addr) {
        invalidations = [
          ...mintInvalidations,
          qkV2Account.sessionLocal(owner),
          qkV2Account.sessionExpiry(wrapperId, addr),
          qkV2Account.sessionGas(addr),
        ];
      }
    }
    return runTx('mint', tx, invalidations, opts);
  }

  /**
   * Start a delegated trading session explicitly (the standalone path; the trade-ticket
   * toggle bundles this into the first trade instead). Reuses the local key if present,
   * else mints a fresh one; deposits `budgetBase` DUSDC into the wrapper for the session
   * to trade with; and authorizes the key for `duration` (default 24h). Gas is handled by
   * resolveSessionGasFunding (treasury drip first, owner top-up as the Slush fallback), so
   * an explicit `gasFundingBase` override wins only when passed.
   */
  async function startSession(opts: {
    budgetBase: bigint;
    duration?: SessionDuration;
    gasFundingBase?: bigint;
  }): Promise<string | null> {
    if (!V2_SESSIONS_ENABLED || !owner || !wrapperId) return null;
    // Reuse the device's key if present, else mint + persist a fresh one. Only the
    // address is needed here (the signer trades through the session executor).
    let sessionAddress = (await loadSession(owner))?.address;
    if (!sessionAddress) {
      sessionAddress = (await saveSession(owner, await generateSession())).address;
    }
    const durationMs = SESSION_DURATIONS_MS[opts.duration ?? DEFAULT_SESSION_DURATION];
    // Treasury drip covers gas for both paths; owner top-up is the Slush fallback. An
    // explicit override (rare) still wins.
    const gasFundingBase =
      opts.gasFundingBase !== undefined
        ? opts.gasFundingBase
        : await resolveSessionGasFunding(sessionAddress);
    return runTx(
      'session',
      buildAuthorizeSessionTx({
        wrapperId,
        sessionAddress,
        durationMs,
        depositBase: opts.budgetBase,
        gasFundingBase,
        // Ride our builder-code attach along in the same popup (owner-gated; a
        // session can't attach it later). Only when the slot is empty.
        attachBuilderCode: builderCode.shouldAttach,
      }),
      [
        qkV2Account.balance(wrapperId),
        qkV2Account.walletDusdc(owner),
        qkV2Account.sessionLocal(owner),
        qkV2Account.sessionExpiry(wrapperId, sessionAddress),
      ],
    );
  }

  /**
   * End the session: sweep the key's leftover gas back to the owner, revoke on-chain
   * (owner-signed), then forget the local key. The sweep MUST come before we clear the
   * key: the funded SUI lives at the session key's own address, and once we delete the
   * non-extractable key it can never be recovered. The session key can still sign a
   * plain transfer even after expiry (only the trade wrappers are gated), so this works
   * whether the session lapsed or the user ended it early.
   */
  async function endSession(): Promise<string | null> {
    if (!V2_SESSIONS_ENABLED || !owner || !wrapperId) return null;
    const loaded = await loadSession(owner);
    const addr = loaded?.address;

    // 1) Best-effort gas sweep — never block ending on it. Skip dust (a sweep that
    //    returns less than its own gas is pointless).
    if (loaded) {
      try {
        const bal = await client.core.getBalance({ owner: loaded.address, coinType: SUI_TYPE });
        if (BigInt(bal.balance.balance) > SESSION_SWEEP_DUST_MIST) {
          const tx = buildSweepSessionGasTx(owner);
          tx.setSender(loaded.address);
          const built = await tx.build({ client });
          const { signature } = await loaded.signer.signTransaction(built);
          const res = await client.core.executeTransaction({ transaction: built, signatures: [signature] });
          if (res.$kind !== 'FailedTransaction') await client.core.waitForTransaction({ digest: res.Transaction.digest });
        }
      } catch {
        // Swept nothing — the revoke below still ends the session cleanly.
      }
    }

    // 2) Owner-signed revoke (the one popup) + forget the local key.
    let digest: string | null = null;
    if (addr) {
      digest = await runTx('session', buildRevokeSessionTx(wrapperId, addr), [
        qkV2Account.sessionExpiry(wrapperId, addr),
      ]);
    }
    await clearSession(owner);
    resetSessionExecutor(); // the key is gone; drop its cached executor + gas chain
    await queryClient.invalidateQueries({ queryKey: qkV2Account.sessionLocal(owner) });
    await queryClient.invalidateQueries({ queryKey: qkV2Account.walletDusdc(owner) });
    return digest;
  }

  return {
    owner,
    wrapperId,
    /** The indexer's account key (positions/orders/history are filed under this,
     *  not the wallet owner). Undefined until the wrapper exists + is resolved. */
    accountId,
    wrapperExists,
    balanceBase,
    plpBalanceBase,
    /** Wallet-held DUSDC (base units) — undefined while the first read is in flight. */
    walletDusdcBase: walletDusdcQ.data,
    busy,
    error,
    /** Clear the last action error — lets a caller dismiss the error banner. */
    clearError: () => setError(null),
    /** True for gasless Enoki (Google) accounts — they sign with no wallet
     *  pop-up, so callers can show honest, wallet-aware copy. */
    gasless,
    isLoading: wrapperQ.isLoading,
    /** Escape hatch for callers that build their own PTB (e.g. the admin fee claim),
     *  so they inherit the same signing path: Enoki sponsorship, the sign-then-execute
     *  workaround, finalized-status check, toasts and invalidation. */
    runTx,
    /** Create + share the AccountWrapper (standalone tx — required before first deposit/mint). */
    createAccount: () => runTx('create', buildCreateAccountTx(), []),
    deposit: (amount: bigint) =>
      wrapperId
        ? runTx('deposit', buildDepositTx(wrapperId, amount), [
            qkV2Account.balance(wrapperId),
            qkV2Account.walletDusdc(owner ?? ''),
          ])
        : Promise.resolve(null),
    withdraw: (amount: bigint) =>
      wrapperId && owner
        ? runTx('withdraw', buildWithdrawTx(wrapperId, amount, owner), [
            qkV2Account.balance(wrapperId),
            qkV2Account.walletDusdc(owner),
          ])
        : Promise.resolve(null),
    /**
     * Cash out DUSDC to an EXTERNAL wallet (for zkLogin users who can't export a
     * key). Drains the account free balance first, then wallet DUSDC, up to
     * `amountBase`, and transfers it to `destination` in one gasless tx. The
     * destination is allowlisted so the Enoki sponsor accepts the outbound
     * transfer. Returns null on bad input (nothing to send, or account funds
     * requested with no wrapper yet).
     */
    cashOut: (destination: string, amountBase: bigint) => {
      if (!owner) return Promise.resolve(null);
      const walletBase = walletDusdcQ.data ?? 0n;
      const available = balanceBase + walletBase;
      const amount = amountBase > available ? available : amountBase;
      if (amount <= 0n) return Promise.resolve(null);
      // Prefer the account's free balance (the allowlisted withdraw keeps the tx
      // sponsorable); spill over to wallet coins only if needed.
      const fromAccount = amount > balanceBase ? balanceBase : amount;
      const fromWallet = amount - fromAccount;
      if (fromAccount > 0n && !wrapperId) return Promise.resolve(null); // need the wrapper to pull account funds
      return runTx(
        'cash-out',
        buildCashOutTx({ wrapperId: wrapperId ?? '', fromAccount, fromWallet, destination }),
        [...(wrapperId ? [qkV2Account.balance(wrapperId)] : []), qkV2Account.walletDusdc(owner)],
        { allowedAddresses: [destination, owner] },
      );
    },
    /** Builder-fee attribution for this account (attach happens inside the mint). */
    builderCode,
    mint: (p: Omit<MintParams, 'wrapperId'>, opts?: TradeOpts) => {
      if (!wrapperId) return Promise.resolve(null);
      // A live session carries the trade popup-less — UNLESS this trade needs a
      // wallet top-up (`deposit`), which only the owner path can do (the session
      // can't move funds from the wallet). Fall back to the owner path there.
      if (sessionActive && !(p.deposit && p.deposit > 0n)) {
        return runSessionTx('mint', buildSessionMintTx({ ...p, wrapperId }), mintInvalidations, opts);
      }
      // Owner path — optionally bundling "turn on instant trading" into this approval.
      return runOwnerMint(buildMintTx({ ...p, wrapperId, attachBuilderCode: builderCode.shouldAttach }), opts);
    },
    /** Budget mint (mint_exact_amount) — the chain sizes the quantity at
     *  execution, so odds drift can't break the $1 minimum-premium check. */
    mintBudget: (p: Omit<MintBudgetParams, 'wrapperId'>, opts?: TradeOpts) => {
      if (!wrapperId) return Promise.resolve(null);
      if (sessionActive && !(p.deposit && p.deposit > 0n)) {
        return runSessionTx('mint', buildSessionMintBudgetTx({ ...p, wrapperId }), mintInvalidations, opts);
      }
      return runOwnerMint(buildMintBudgetTx({ ...p, wrapperId, attachBuilderCode: builderCode.shouldAttach }), opts);
    },
    redeemLive: (p: Omit<RedeemParams, 'wrapperId'>, opts?: { silentSuccess?: boolean }) => {
      if (!wrapperId) return Promise.resolve(null);
      if (sessionActive) return runSessionTx('redeem', buildSessionRedeemLiveTx({ ...p, wrapperId }), redeemInvalidations, opts);
      return runTx('redeem', buildRedeemLiveTx({ ...p, wrapperId }), redeemInvalidations, opts);
    },
    // A winning claim passes silentSuccess so the caller can own the celebration
    // (SuccessModal + confetti) instead of the quiet bottom-right toast.
    redeemSettled: (p: Omit<RedeemParams, 'wrapperId'>, opts?: { silentSuccess?: boolean }) => {
      if (!wrapperId) return Promise.resolve(null);
      if (sessionActive) return runSessionTx('redeem', buildSessionRedeemSettledTx({ ...p, wrapperId }), redeemInvalidations, opts);
      return runTx('redeem', buildRedeemSettledTx({ ...p, wrapperId }), redeemInvalidations, opts);
    },
    /* ---- async vault (PLP) ---- */
    requestSupply: (amount: bigint, deposit?: bigint) =>
      wrapperId
        ? runTx('supply', buildRequestSupplyTx({ wrapperId, amount, deposit }), vaultInvalidations)
        : Promise.resolve(null),
    requestWithdraw: (plpAmount: bigint) =>
      wrapperId
        ? runTx('withdraw-lp', buildRequestWithdrawTx(wrapperId, plpAmount), vaultInvalidations)
        : Promise.resolve(null),
    cancelSupply: (index: bigint) =>
      wrapperId ? runTx('cancel', buildCancelSupplyTx(wrapperId, index), vaultInvalidations) : Promise.resolve(null),
    cancelWithdraw: (index: bigint) =>
      wrapperId ? runTx('cancel', buildCancelWithdrawTx(wrapperId, index), vaultInvalidations) : Promise.resolve(null),
    /* ---- delegated trading sessions (Phase 1: lifecycle; dark behind V2_SESSIONS_ENABLED) ---- */
    /** Whether sessions are available at all (package published on this deployment + flag on). */
    sessionsEnabled: V2_SESSIONS_ENABLED,
    /** The local session key's address, if one exists on this device. */
    sessionAddress: localSession?.address ?? null,
    /** On-chain expiry (ms) of the local session, or null if not authorized. */
    sessionExpiryMs,
    /** SUI (base units) the local session key holds for gas — drives the "still has
     *  gas, no SUI needed" note on re-enable, and the top-up-the-difference math. */
    sessionGasBase,
    /** True when the session is authorized and unexpired (safe to trade through). */
    sessionLive,
    /** True when trades are ACTUALLY routing through the session right now (Slush +
     *  live key). Gasless users are excluded — they already trade popup-less. */
    sessionActive,
    startSession,
    endSession,
  };
}
