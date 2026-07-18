'use client';

/**
 * BuilderCodePanel — register a builder code, and claim the fees it earns.
 *
 * There is NO "approve this wallet" step, and this is the thing people expect and
 * don't find: `BuilderCode.owner` is stamped with whoever SIGNS
 * `create_builder_code`, has no setter, and the object has no `store` ability so it
 * can't be transferred either. Ownership can only be established by registering
 * from the wallet itself. The chain then refuses `claim_all_builder_fees` from
 * anyone else (`assert_owner`) — hiding the button is courtesy; that assert is the
 * lock.
 *
 * The claim DESTINATION, by contrast, is free: the call returns a Coin<DUSDC> and
 * the PTB decides where it lands. Permanent key, disposable destination — that
 * asymmetry is the whole treasury story and the copy says so.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LuCoins, LuShieldCheck, LuTriangleAlert, LuPlus, LuCopy, LuCheck } from 'react-icons/lu';
import { predictV2Config, builderCodeEnabled, isAdminAddress } from '@/config/predict';
import { getBuilderCodeFees, qkV2 } from '@/lib/api/v2/client';
import { useMounted } from '@/lib/hooks/use-mounted';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import {
  useBuilderCodeAdmin,
  useOwnedBuilderCodes,
  qkBuilderCode,
} from '@/lib/hooks/use-builder-code';
import { buildClaimBuilderFeesTx, buildRegisterBuilderCodeTx } from '@/lib/sui/v2/builder-code';
import { fromQuote } from '@/config/scale';

const ADDR_RE = /^0x[0-9a-fA-F]{64}$/;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function BuilderCodePanel() {
  const mounted = useMounted();
  const acct = usePredictAccountV2();
  const admin = useBuilderCodeAdmin();
  const owned = useOwnedBuilderCodes();

  if (!mounted) return null;

  if (!acct.owner) {
    return (
      <Card>
        <p className="text-[12px] text-text-3">Connect the team wallet to continue.</p>
      </Card>
    );
  }

  // The wallet owns the code the app is configured to use → the normal case.
  if (builderCodeEnabled && admin.isOwner) {
    return <Claim />;
  }

  // Anyone else. Registering is permissionless on-chain, so this isn't a security
  // boundary — but a stranger who guessed the URL has no business being handed
  // founder tooling, and a code they registered would earn them nothing anyway
  // (the app only attributes to the code in its own config). Show a dead end and
  // leak nothing about the deployment.
  if (!isAdminAddress(acct.owner)) {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <LuShieldCheck size={18} className="mt-0.5 shrink-0 text-text-3" />
          <p className="text-[12px] leading-relaxed text-text-3">
            This page is for the Skew team. The connected wallet doesn’t have access.
          </p>
        </div>
      </Card>
    );
  }

  // A team wallet that isn't (yet) the owner: it can register a code, or be told
  // which wallet to connect instead.
  return (
    <div className="flex flex-col gap-4">
      {builderCodeEnabled && (
        <Card>
          <div className="flex items-start gap-3">
            <LuShieldCheck size={18} className="mt-0.5 shrink-0 text-text-3" />
            <p className="text-[12px] leading-relaxed text-text-3">
              This app is attributing trades to a code owned by{' '}
              <span className="font-mono text-text-2">
                {admin.owner ? short(admin.owner) : '—'}
              </span>
              , which isn’t this wallet — so the chain won’t let you claim from it. Either
              connect that wallet, or register your own code below.
            </p>
          </div>
        </Card>
      )}
      <Register owned={owned} />
    </div>
  );
}

/* ------------------------------- register -------------------------------- */

function Register({ owned }: { owned: ReturnType<typeof useOwnedBuilderCodes> }) {
  const acct = usePredictAccountV2();
  const [copied, setCopied] = useState<string | null>(null);

  // Codes are derived from (owner, index) — re-using a pair aborts, so the next
  // index is simply one past the highest this wallet already holds.
  const nextIndex = owned.codes.reduce((m, c) => Math.max(m, c.index + 1), 0);

  async function register() {
    const digest = await acct.runTx('register-builder', buildRegisterBuilderCodeTx(BigInt(nextIndex)), [
      qkBuilderCode.state(),
    ]);
    if (digest) owned.refetch();
  }

  async function copy(v: string) {
    await navigator.clipboard.writeText(v);
    setCopied(v);
    setTimeout(() => setCopied(null), 1500);
  }

  const busy = acct.busy === 'register-builder';

  return (
    <>
      <Card>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <LuPlus size={15} className="text-accent" />
            <span className="text-[13px] font-medium text-text-1">Register a builder code</span>
          </div>
          <p className="text-[11px] leading-relaxed text-text-3">
            Signing this makes <span className="font-mono text-text-2">{short(acct.owner ?? '')}</span>{' '}
            the code’s owner — <span className="text-text-2">permanently</span>. There is no way to
            reassign or transfer it afterwards, and losing the key forfeits every fee it would ever
            earn. On mainnet, sign this from a multisig.
          </p>
          <button
            type="button"
            onClick={register}
            disabled={busy}
            className="rounded-lg border border-up/50 bg-[var(--accent-soft)] py-2.5 text-[12px] font-semibold text-accent transition-colors hover:bg-up/15 disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-text-3"
          >
            {busy ? 'Confirming…' : `Register code (index ${nextIndex})`}
          </button>
        </div>
      </Card>

      {owned.codes.length > 0 && (
        <Card>
          <div className="flex flex-col gap-3">
            <span className="eyebrow">Codes owned by this wallet</span>
            {owned.codes.map((c) => (
              <button
                key={c.codeId}
                type="button"
                onClick={() => copy(c.codeId)}
                className="glass-inset flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-white/5"
              >
                <span className="truncate font-mono text-[11px] text-text-2">{c.codeId}</span>
                {copied === c.codeId ? (
                  <LuCheck size={13} className="shrink-0 text-accent" />
                ) : (
                  <LuCopy size={13} className="shrink-0 text-text-3" />
                )}
              </button>
            ))}
            {owned.misconfigured && (
              <div className="flex items-start gap-2 border-t border-line pt-3">
                <LuTriangleAlert size={14} className="mt-0.5 shrink-0 text-down" />
                <p className="text-[11px] leading-relaxed text-text-3">
                  You own a code, but the app is still attributing trades to a different one — so
                  fees keep accruing to that code, not yours. Set{' '}
                  <span className="font-mono text-text-2">NEXT_PUBLIC_BUILDER_CODE_ID</span> to the
                  id above and restart, then this page will switch to claiming.
                </p>
              </div>
            )}
          </div>
        </Card>
      )}
    </>
  );
}

/* --------------------------------- claim --------------------------------- */

function Claim() {
  const acct = usePredictAccountV2();
  const { owner, claimable, isLoading, refetch } = useBuilderCodeAdmin();
  const [dest, setDest] = useState('');

  // Lifetime swept fees, from the indexer's claim log (complements the on-chain
  // `claimable`, which only ever shows what's UNclaimed right now).
  const codeId = predictV2Config.builderCodeId;
  const feesQ = useQuery({
    queryKey: qkV2.builderCodeFees(codeId),
    queryFn: () => getBuilderCodeFees(codeId),
    enabled: !!codeId,
    refetchInterval: 60_000,
  });
  const claimedToDate = (feesQ.data ?? []).reduce((s, f) => s + fromQuote(f.amount), 0);

  const recipient = dest.trim() === '' ? (owner ?? '') : dest.trim();
  const destValid = dest.trim() === '' || ADDR_RE.test(dest.trim());
  const busy = acct.busy === 'claim-builder';
  const canClaim = claimable > 0n && destValid && !busy;

  async function claim() {
    if (!canClaim) return;
    const digest = await acct.runTx('claim-builder', buildClaimBuilderFeesTx(recipient), [
      qkBuilderCode.state(),
    ]);
    if (digest) {
      setDest('');
      refetch();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="grid grid-cols-3 gap-3">
          <div className="flex flex-col gap-1">
            <span className="eyebrow">Unclaimed</span>
            <span className="font-mono text-[18px] leading-none tabular-nums text-text-1">
              {isLoading ? '—' : `$${fromQuote(claimable).toFixed(2)}`}
            </span>
            <span className="text-[10px] text-text-3">accrued on-chain</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="eyebrow">Claimed to date</span>
            <span className="font-mono text-[18px] leading-none tabular-nums text-text-1">
              {feesQ.isLoading ? '—' : `$${claimedToDate.toFixed(2)}`}
            </span>
            <span className="text-[10px] text-text-3">
              {feesQ.data?.length ? `${feesQ.data.length} claims` : 'no claims yet'}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="eyebrow">Code owner</span>
            <span className="font-mono text-[18px] leading-none tabular-nums text-text-1">
              {owner ? short(owner) : '—'}
            </span>
            <span className="text-[10px] text-text-3">you · permanent</span>
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <LuCoins size={15} className="text-accent" />
            <span className="text-[13px] font-medium text-text-1">Claim builder fees</span>
          </div>
          <p className="text-[11px] leading-relaxed text-text-3">
            Sweeps everything accrued to the code. Leave blank to send it to the owner wallet, or
            paste any address to route it elsewhere — the destination is chosen per claim and isn’t
            stored on-chain.
          </p>
          <input
            type="text"
            value={dest}
            onChange={(e) => setDest(e.target.value)}
            placeholder={owner ?? '0x…'}
            spellCheck={false}
            className="glass-inset w-full rounded-lg px-3 py-2 font-mono text-[12px] text-text-1 outline-none placeholder:text-text-3/60"
          />
          <button
            type="button"
            onClick={claim}
            disabled={!canClaim}
            className="rounded-lg border border-up/50 bg-[var(--accent-soft)] py-2.5 text-[12px] font-semibold text-accent transition-colors hover:bg-up/15 disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-text-3"
          >
            {busy
              ? 'Confirming…'
              : claimable > 0n
                ? `Claim $${fromQuote(claimable).toFixed(2)}`
                : 'Nothing to claim yet'}
          </button>
          {!destValid && (
            <span className="text-[11px] text-down">
              Not a valid Sui address (0x + 64 hex chars).
            </span>
          )}
        </div>
      </Card>

      {predictV2Config.network !== 'mainnet' && (
        <Card>
          <div className="flex items-start gap-3">
            <LuTriangleAlert size={16} className="mt-0.5 shrink-0 text-text-3" />
            <p className="text-[11px] leading-relaxed text-text-3">
              Testnet. At mainnet you’ll register a fresh code — sign that one from a{' '}
              <span className="text-text-2">multisig</span>, because whoever signs it owns the fee
              revenue forever and re-registering later would force every user to re-attach.
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="glass-card p-4">{children}</div>;
}
