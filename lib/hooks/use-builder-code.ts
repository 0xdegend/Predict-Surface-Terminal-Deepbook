'use client';

/**
 * useBuilderCode / useBuilderCodeAdmin — the two sides of the native builder fee.
 *
 * Trader side: which BuilderCode (if any) is attached to this account, and should
 * the next mint attach ours? Attribution lives on the ACCOUNT, so this is the only
 * thing standing between a trade on Skew and a fee we never see.
 *
 * Admin side: who owns our code (immutable) and how much DUSDC is waiting.
 *
 * POLICY (the protocol's intended use, confirmed by the lead 2026-08-16) — we ensure
 * OUR code is on the account for every trade placed here: attach when the slot is empty
 * OR carries another app's code, and skip only when it's already ours. `set_builder_code`
 * is last-writer-wins with no overwrite guard, so this is exactly how the protocol expects
 * each app to attribute its own trades, and the user can change or unset it any time.
 * `hasForeignCode` stays as telemetry (how often a user arrives carrying a rival's code).
 */
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { useV2ReadClient } from '@/lib/sui/grpc';
import { useQuery } from '@tanstack/react-query';
import { predictV2Config, builderCodeEnabled } from '@/config/predict';
import { getBuilderCodeFees, qkV2 } from '@/lib/api/v2/client';
import { fromQuote } from '@/config/scale';
import {
  readAttachedBuilderCode,
  readBuilderCodeState,
  findBuilderCodesByOwner,
  type OwnedBuilderCode,
} from '@/lib/sui/v2/builder-code';

export const qkBuilderCode = {
  attached: (wrapperId: string) => ['v2', 'builder-code', 'attached', wrapperId] as const,
  state: () => ['v2', 'builder-code', 'state', predictV2Config.builderCodeId] as const,
  owned: (owner: string) => ['v2', 'builder-code', 'owned', owner] as const,
};

export interface BuilderCodeStatus {
  /** The code on this account, or null when the slot is empty. */
  attachedCodeId: string | null;
  /** The account is already attributed to us — mints go through unchanged. */
  isOurs: boolean;
  /** The account carries ANOTHER app's code. We now overwrite it on the next trade
   *  (the intended attribution pattern); this flag stays for telemetry. */
  hasForeignCode: boolean;
  /** Ride a `set_builder_code` along with the next mint. */
  shouldAttach: boolean;
  isLoading: boolean;
}

export function useBuilderCode(wrapperId: string | undefined): BuilderCodeStatus {
  const client = useV2ReadClient();

  const q = useQuery({
    queryKey: qkBuilderCode.attached(wrapperId ?? ''),
    queryFn: () => readAttachedBuilderCode(client.core, wrapperId!),
    enabled: builderCodeEnabled && !!wrapperId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const ours = predictV2Config.builderCodeId.toLowerCase();
  const attachedCodeId = q.data ?? null;
  const isOurs = !!attachedCodeId && attachedCodeId.toLowerCase() === ours;
  const hasForeignCode = !!attachedCodeId && !isOurs;

  return {
    attachedCodeId,
    isOurs,
    hasForeignCode,
    // Attach whenever the account isn't already ours (empty OR a rival's code), so
    // trades placed here always credit us; skip only when it's already ours (no
    // redundant command). While the read is in flight we hold off rather than guess.
    shouldAttach: builderCodeEnabled && !!wrapperId && q.isSuccess && !isOurs,
    isLoading: q.isLoading,
  };
}

export interface BuilderCodeAdmin {
  /** Permanent owner of the code — the only address that can ever claim. */
  owner: string | null;
  /** Unclaimed DUSDC, base units. */
  claimable: bigint;
  /** The connected wallet is that owner. */
  isOwner: boolean;
  isLoading: boolean;
  refetch: () => void;
}

export interface OwnedBuilderCodes {
  /** Codes registered BY the connected wallet (it can claim from any of them). */
  codes: OwnedBuilderCode[];
  /** It owns at least one code, but the app isn't configured to attribute to it —
   *  trades would still credit the OTHER code. Needs NEXT_PUBLIC_BUILDER_CODE_ID. */
  misconfigured: boolean;
  isLoading: boolean;
  refetch: () => void;
}

/**
 * Which BuilderCodes the connected wallet owns. There's no on-chain owner→code
 * index, so this reads the creation events. Drives the "register a code" flow:
 * ownership can only be established by SIGNING `create_builder_code`, so the
 * wallet that wants the revenue has to do it itself — there is no approve step
 * and no way to hand ownership over afterwards.
 */
export function useOwnedBuilderCodes(): OwnedBuilderCodes {
  const account = useCurrentAccount();
  const owner = account?.address ?? null;

  const q = useQuery({
    queryKey: qkBuilderCode.owned(owner ?? ''),
    queryFn: ({ signal }) => findBuilderCodesByOwner(owner!, signal),
    enabled: !!owner,
    staleTime: 30_000,
  });

  const codes = q.data ?? [];
  const configured = predictV2Config.builderCodeId.toLowerCase();
  const misconfigured =
    codes.length > 0 && !codes.some((c) => c.codeId.toLowerCase() === configured);

  return { codes, misconfigured, isLoading: q.isLoading, refetch: () => void q.refetch() };
}

export function useBuilderCodeAdmin(): BuilderCodeAdmin {
  const account = useCurrentAccount();
  const client = useV2ReadClient();
  const owner = account?.address ?? null;

  const q = useQuery({
    queryKey: qkBuilderCode.state(),
    queryFn: () => readBuilderCodeState(client.core),
    enabled: builderCodeEnabled,
    refetchInterval: 30_000,
  });

  return {
    owner: q.data?.owner ?? null,
    claimable: q.data?.claimable ?? 0n,
    isOwner: !!owner && !!q.data && q.data.owner.toLowerCase() === owner.toLowerCase(),
    isLoading: q.isLoading,
    refetch: () => void q.refetch(),
  };
}

export interface BuilderFeeSummary {
  /** Unclaimed DUSDC waiting on-chain right now (float). */
  unclaimed: number;
  /** Sum of every fee ever swept, from the indexer's claim log (float). */
  claimedToDate: number;
  /** unclaimed + claimedToDate — the headline "lifetime earned". */
  lifetime: number;
  claimCount: number;
  isLoading: boolean;
}

/**
 * The builder fee in three numbers, so the admin console's summary ribbon and the
 * claim panel read from ONE place and can't drift. `claimable` is the live on-chain
 * unclaimed balance; the claim log gives lifetime-claimed; together they're lifetime
 * earned. Both underlying queries are keyed, so calling this alongside the panel adds
 * no extra network.
 */
export function useBuilderFeeSummary(): BuilderFeeSummary {
  const { claimable, isLoading: adminLoading } = useBuilderCodeAdmin();
  const codeId = predictV2Config.builderCodeId;

  const feesQ = useQuery({
    queryKey: qkV2.builderCodeFees(codeId),
    queryFn: () => getBuilderCodeFees(codeId),
    enabled: !!codeId,
    refetchInterval: 60_000,
  });

  const fees = feesQ.data ?? [];
  const claimedToDate = fees.reduce((s, f) => s + fromQuote(f.amount), 0);
  const unclaimed = fromQuote(claimable);

  return {
    unclaimed,
    claimedToDate,
    lifetime: unclaimed + claimedToDate,
    claimCount: fees.length,
    isLoading: adminLoading || feesQ.isLoading,
  };
}
