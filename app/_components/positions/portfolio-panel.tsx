'use client';

/**
 * Portfolio — the trader's account home. Account header (value, free balance,
 * exposure, PnL), then open positions as cards and a settled/redeemable section.
 * All position/manager amounts are de-scaled in `positionMetrics` / here (server
 * gives @6dec base units). Redeeming routes through a confirmation modal.
 */
import { useState } from 'react';
import Link from 'next/link';
import { usePredictAccount } from '@/lib/hooks/use-predict-account';
import { useNow } from '@/lib/hooks/use-now';
import { useMounted } from '@/lib/hooks/use-mounted';
import { fromQuote } from '@/config/scale';
import { quote as fmtQuote, signed } from '@/lib/format';
import { predictConfig } from '@/config/predict';
import { PositionCard } from './position-card';
import { RedeemModal } from './redeem-modal';
import type { PositionSummary } from '@/lib/api/types';

const EXPLORER = (digest: string) => `https://suiscan.xyz/testnet/tx/${digest}`;

export function PortfolioPanel({ serverNow }: { serverNow: number }) {
  const acct = usePredictAccount();
  const now = useNow(serverNow);
  const mounted = useMounted();
  const [redeeming, setRedeeming] = useState<PositionSummary | null>(null);

  if (!mounted) {
    return (
      <Centered>
        <p className="text-[12px] text-text-3">Loading account…</p>
      </Centered>
    );
  }

  if (!acct.owner) {
    return (
      <Centered>
        <p className="text-[13px] text-text-2">Connect a wallet to view your portfolio.</p>
        <p className="mt-1 text-[12px] text-text-3">Use the connect button in the top bar.</p>
      </Centered>
    );
  }

  if (acct.managersLoading) {
    return <Centered>
      <p className="text-[12px] text-text-3">Loading account…</p>
    </Centered>;
  }

  if (!acct.managerId) {
    return (
      <Centered>
        <p className="text-[13px] text-text-2">You don’t have a trading account yet.</p>
        <p className="mt-1 max-w-sm text-[12px] text-text-3">
          Create a manager — a personal vault that holds your DUSDC and positions — then mint your
          first contract from the surface.
        </p>
        <button
          onClick={() => acct.createManager()}
          disabled={acct.busy === 'create'}
          className="mt-4 rounded border border-line-strong bg-up/10 px-4 py-2 text-[12px] font-medium text-up hover:bg-up/20 disabled:opacity-50"
        >
          {acct.busy === 'create' ? 'creating…' : 'Create trading account'}
        </button>
        <Link href="/" className="mt-3 text-[11px] text-text-3 underline hover:text-text-2">
          ← back to the surface
        </Link>
      </Centered>
    );
  }

  const s = acct.summary;
  const positions = acct.positions;
  const open = positions.filter((p) => p.open_quantity > 0 && p.status !== 'settled' && p.status !== 'awaiting_settlement');
  const redeemable = positions.filter(
    (p) => p.open_quantity > 0 && (p.status === 'settled' || p.status === 'awaiting_settlement'),
  );

  const totalPnl = s ? fromQuote(s.realized_pnl + s.unrealized_pnl) : 0;
  const unrealized = s ? fromQuote(s.unrealized_pnl) : 0;
  const unrealizedPct = s && s.open_exposure > 0 ? s.unrealized_pnl / s.open_exposure : 0;

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-6">
      {/* Account header */}
      <div className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line-soft shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)] sm:grid-cols-3 lg:grid-cols-5">
        <Tile label="Account value" value={s ? fmtQuote(fromQuote(s.account_value)) : '…'} accent />
        <Tile
          label="Total PnL"
          value={s ? signed(totalPnl) : '…'}
          tone={totalPnl >= 0 ? 'up' : 'down'}
        />
        <Tile label="Open exposure" value={s ? fmtQuote(fromQuote(s.open_exposure)) : '…'} />
        <Tile
          label="Free balance"
          value={s ? fmtQuote(fromQuote(s.trading_balance)) : '…'}
          sub={
            acct.tradingBalanceBase > 0n ? (
              <button
                onClick={() => acct.withdrawAll()}
                disabled={acct.busy === 'withdraw'}
                className="text-[10px] text-text-2 underline hover:text-text-1 disabled:opacity-50"
              >
                {acct.busy === 'withdraw' ? 'withdrawing…' : 'withdraw'}
              </button>
            ) : undefined
          }
        />
        <Tile
          label="Wallet DUSDC"
          value={acct.dusdcBalance === undefined ? '…' : fmtQuote(fromQuote(acct.dusdcBalance))}
        />
      </div>

      {acct.error && (
        <div className="mb-4 rounded border border-down/40 bg-down/10 p-2 font-mono text-[12px] text-down">
          {acct.error}
        </div>
      )}

      {/* Redeemable (settled) — surfaced first, it's money waiting to be claimed */}
      {redeemable.length > 0 && (
        <Section title="Ready to redeem" hint="settled — claim your payout">
          <Grid>
            {redeemable.map((p) => (
              <PositionCard
                key={`${p.oracle_id}-${p.strike}-${p.is_up}`}
                position={p}
                now={now}
                busy={!!acct.busy}
                onRedeem={setRedeeming}
              />
            ))}
          </Grid>
        </Section>
      )}

      {/* Open positions */}
      <Section
        title="Open positions"
        hint={
          open.length > 0
            ? `${signed(unrealized)} unrealized (${signed(unrealizedPct * 100, 1)}%)`
            : undefined
        }
        hintTone={unrealized >= 0 ? 'up' : 'down'}
      >
        {open.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line-soft p-8 text-center">
            <p className="text-[13px] text-text-2">No open positions.</p>
            <Link
              href="/"
              className="mt-2 inline-block text-[12px] text-up underline hover:opacity-80"
            >
              Open the surface and mint your first contract →
            </Link>
          </div>
        ) : (
          <Grid>
            {open.map((p) => (
              <PositionCard
                key={`${p.oracle_id}-${p.strike}-${p.is_up}`}
                position={p}
                now={now}
                busy={!!acct.busy}
                onRedeem={setRedeeming}
              />
            ))}
          </Grid>
        )}
      </Section>

      {acct.lastDigest && (
        <a
          href={EXPLORER(acct.lastDigest)}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-block font-mono text-[10px] text-text-3 underline hover:text-text-2"
        >
          last tx: {acct.lastDigest.slice(0, 12)}… ↗
        </a>
      )}

      <RedeemModal
        position={redeeming}
        busy={!!acct.busy}
        onConfirm={async (p) => {
          await acct.redeem(p);
          setRedeeming(null);
        }}
        onClose={() => setRedeeming(null)}
      />

      <p className="mt-6 text-[10px] text-text-3">Quote asset · {predictConfig.quote.symbol} · {predictConfig.network}</p>
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  tone,
  accent,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  tone?: 'up' | 'down';
  accent?: boolean;
}) {
  const color = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text-1';
  return (
    <div
      className={`flex flex-col gap-1.5 px-4 py-3.5 ${
        accent
          ? 'bg-linear-to-b from-[var(--accent-soft)] to-transparent'
          : 'bg-bg-1'
      }`}
    >
      <span className="eyebrow">{label}</span>
      <span
        className={`font-mono leading-none tabular-nums ${accent ? 'text-[22px]' : 'text-[16px]'} ${color}`}
      >
        {value}
      </span>
      {sub}
    </div>
  );
}

function Section({
  title,
  hint,
  hintTone,
  children,
}: {
  title: string;
  hint?: string;
  hintTone?: 'up' | 'down';
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-text-2">
          <span className="h-3 w-px bg-accent/70" />
          {title}
        </h2>
        {hint && (
          <span
            className={`font-mono text-[11px] tabular-nums ${
              hintTone === 'up' ? 'text-up' : hintTone === 'down' ? 'text-down' : 'text-text-3'
            }`}
          >
            {hint}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 md:grid-cols-2">{children}</div>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-5 py-24 text-center">
      {children}
    </div>
  );
}
