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
 * POLICY — we attach only when the slot is EMPTY. `set_builder_code` has no
 * overwrite guard on-chain, so we *could* re-attribute a user who arrives carrying
 * a rival's code (and they could take ours the same way — it's last-writer-wins).
 * We don't, because that would silently reassign something the user opted into
 * elsewhere. `hasForeignCode` exists to MEASURE how often that happens, so the
 * call can be made on evidence rather than guesswork.
 */
import { useCurrentAccount, useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery } from '@tanstack/react-query';
import { predictV2Config, builderCodeEnabled } from '@/config/predict';
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
  /** The account carries ANOTHER app's code: they trade here, that app earns.
   *  We deliberately do not overwrite it — this flag is for telemetry. */
  hasForeignCode: boolean;
  /** Ride a `set_builder_code` along with the next mint. */
  shouldAttach: boolean;
  isLoading: boolean;
}

export function useBuilderCode(wrapperId: string | undefined): BuilderCodeStatus {
  const client = useCurrentClient();

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
    // Only when we KNOW the slot is empty. While the read is in flight we hold
    // off rather than guess — a wrong attach is a wasted command in the user's
    // PTB, and worse, an overwrite we explicitly promised not to do.
    shouldAttach: builderCodeEnabled && !!wrapperId && q.isSuccess && attachedCodeId === null,
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
  const client = useCurrentClient();
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
