'use client';

/**
 * AdminPanel — founder-only controls for the Skew builder fee (skew_fee router).
 *
 * Gated three ways: (1) the Fee Admin nav link only shows for the AdminCap owner,
 * (2) this panel renders controls only when the connected wallet owns the cap,
 * and (3) the chain enforces it — `set_fee_bps`/`set_treasury` require the
 * `&AdminCap`, so a non-owner physically can't sign them. Hiding the UI is just
 * courtesy; the capability is the real lock.
 */
import { useState } from 'react';
import { LuKeyRound, LuShieldCheck } from 'react-icons/lu';
import { predictConfig, feeRouterEnabled } from '@/config/predict';
import { useMounted } from '@/lib/hooks/use-mounted';
import { usePredictAccount } from '@/lib/hooks/use-predict-account';
import { useAdminCap } from '@/lib/hooks/use-admin-cap';
import { useFeeConfig } from '@/lib/hooks/use-skew-fee';
import { buildSetFeeBpsTx, buildSetTreasuryTx } from '@/lib/sui/predict-tx';

const MAX_FEE_BPS = 200; // mirrors the on-chain cap (2.00%)
const ADDR_RE = /^0x[0-9a-fA-F]{64}$/;
const feeKeys = [
  ['fee-config', predictConfig.feeConfigId],
  ['skew-fee-bps', predictConfig.skewFeePackageId, predictConfig.feeConfigId],
] as const;

export function AdminPanel() {
  const mounted = useMounted();
  const acct = usePredictAccount();
  const { isAdmin, adminCapId, isLoading: capLoading } = useAdminCap();
  const { feeBps, treasury, refetch } = useFeeConfig();

  if (!mounted) return <Shell><p className="text-[12px] text-text-3">Loading…</p></Shell>;

  if (!feeRouterEnabled) {
    return (
      <Shell>
        <p className="text-[12px] text-text-3">
          The fee router isn’t deployed for this network — nothing to administer.
        </p>
      </Shell>
    );
  }
  if (!acct.owner) {
    return (
      <Shell>
        <p className="text-[12px] text-text-3">Connect the admin wallet (top-right) to manage the fee.</p>
      </Shell>
    );
  }
  if (capLoading) {
    return <Shell><p className="text-[12px] text-text-3">Checking admin access…</p></Shell>;
  }
  if (!isAdmin || !adminCapId) {
    return (
      <Shell>
        <div className="glass-card flex items-center gap-3 p-4">
          <LuShieldCheck size={18} className="text-text-3" />
          <p className="text-[12px] leading-relaxed text-text-3">
            This wallet doesn’t hold the Skew <span className="text-text-2">AdminCap</span>, so it can’t
            change the fee. Connect the admin wallet to continue.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <Controls
        adminCapId={adminCapId}
        currentBps={feeBps}
        currentTreasury={treasury}
        busy={acct.busy}
        runTx={acct.runTx}
        onChanged={() => refetch()}
      />
    </Shell>
  );
}

function Controls({
  adminCapId,
  currentBps,
  currentTreasury,
  busy,
  runTx,
  onChanged,
}: {
  adminCapId: string;
  currentBps: number;
  currentTreasury: string;
  busy: string | null;
  runTx: ReturnType<typeof usePredictAccount>['runTx'];
  onChanged: () => void;
}) {
  const [feePct, setFeePct] = useState('');
  const [treasury, setTreasury] = useState('');

  const nextBps = feePct.trim() === '' ? null : Math.round(parseFloat(feePct) * 100);
  const feeValid =
    nextBps != null && Number.isFinite(nextBps) && nextBps >= 0 && nextBps <= MAX_FEE_BPS && nextBps !== currentBps;
  const treasuryValid = ADDR_RE.test(treasury.trim()) && treasury.trim() !== currentTreasury;

  async function updateFee() {
    if (!feeValid || nextBps == null) return;
    const digest = await runTx('admin-fee', buildSetFeeBpsTx(adminCapId, nextBps), feeKeys);
    if (digest) {
      setFeePct('');
      onChanged();
    }
  }
  async function updateTreasury() {
    if (!treasuryValid) return;
    const digest = await runTx('admin-treasury', buildSetTreasuryTx(adminCapId, treasury.trim()), feeKeys);
    if (digest) {
      setTreasury('');
      onChanged();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Current state */}
      <div className="glass-card grid grid-cols-2 gap-3 p-4">
        <Stat label="Current fee" value={`${(currentBps / 100).toFixed(2)}%`} sub={`${currentBps} bps`} />
        <Stat
          label="Treasury"
          value={`${currentTreasury.slice(0, 6)}…${currentTreasury.slice(-4)}`}
          sub="receives fees"
        />
      </div>

      {/* Set fee */}
      <div className="glass-card flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <LuKeyRound size={15} className="text-accent" />
          <span className="text-[13px] font-medium text-text-1">Set builder fee</span>
        </div>
        <p className="text-[11px] leading-relaxed text-text-3">
          Charged on top of every bet, at mint. Capped on-chain at {MAX_FEE_BPS / 100}%.
        </p>
        <div className="flex items-center gap-2">
          <div className="glass-inset flex items-center gap-1 rounded-lg px-3 py-2">
            <input
              type="number"
              min={0}
              max={MAX_FEE_BPS / 100}
              step={0.05}
              value={feePct}
              onChange={(e) => setFeePct(e.target.value)}
              placeholder={(currentBps / 100).toFixed(2)}
              className="w-20 bg-transparent text-right font-mono text-[14px] tabular-nums text-text-1 outline-none"
            />
            <span className="text-[12px] text-text-3">%</span>
          </div>
          <button
            type="button"
            onClick={updateFee}
            disabled={!feeValid || busy === 'admin-fee'}
            className="flex-1 rounded-lg border border-up/50 bg-[var(--accent-soft)] py-2.5 text-[12px] font-semibold text-accent transition-colors hover:bg-up/15 disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-text-3"
          >
            {busy === 'admin-fee' ? 'Confirming…' : 'Update fee'}
          </button>
        </div>
        {nextBps != null && (nextBps < 0 || nextBps > MAX_FEE_BPS) && (
          <span className="text-[11px] text-down">Fee must be between 0% and {MAX_FEE_BPS / 100}%.</span>
        )}
      </div>

      {/* Set treasury */}
      <div className="glass-card flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <LuShieldCheck size={15} className="text-accent" />
          <span className="text-[13px] font-medium text-text-1">Set treasury</span>
        </div>
        <p className="text-[11px] leading-relaxed text-text-3">
          Where collected fees are sent. Use a dedicated address (ideally a multisig).
        </p>
        <input
          type="text"
          value={treasury}
          onChange={(e) => setTreasury(e.target.value)}
          placeholder={currentTreasury}
          spellCheck={false}
          className="glass-inset w-full rounded-lg px-3 py-2 font-mono text-[12px] text-text-1 outline-none placeholder:text-text-3/60"
        />
        <button
          type="button"
          onClick={updateTreasury}
          disabled={!treasuryValid || busy === 'admin-treasury'}
          className="rounded-lg border border-up/50 bg-[var(--accent-soft)] py-2.5 text-[12px] font-semibold text-accent transition-colors hover:bg-up/15 disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-text-3"
        >
          {busy === 'admin-treasury' ? 'Confirming…' : 'Update treasury'}
        </button>
        {treasury.trim() !== '' && !ADDR_RE.test(treasury.trim()) && (
          <span className="text-[11px] text-down">Not a valid Sui address (0x + 64 hex chars).</span>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="eyebrow">{label}</span>
      <span className="font-mono text-[18px] leading-none tabular-nums text-text-1">{value}</span>
      <span className="text-[10px] text-text-3">{sub}</span>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-lg px-4 py-8 sm:py-12">
      <div className="mb-5 flex items-center gap-2">
        <LuKeyRound size={18} className="text-accent" />
        <h1 className="text-[15px] font-semibold tracking-tight text-text-1">Fee Admin</h1>
      </div>
      {children}
    </div>
  );
}
