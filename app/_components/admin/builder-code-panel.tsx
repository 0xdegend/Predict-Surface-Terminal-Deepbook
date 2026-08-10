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
import { useNow } from '@/lib/hooks/use-now';
import { LineChart, type ChartPoint } from '@/app/_components/analytics/charts/line-chart';
import { useMounted } from '@/lib/hooks/use-mounted';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import {
  useBuilderCodeAdmin,
  useOwnedBuilderCodes,
  qkBuilderCode,
} from '@/lib/hooks/use-builder-code';
import { buildClaimBuilderFeesTx, buildRegisterBuilderCodeTx } from '@/lib/sui/v2/builder-code';
import { fromQuote } from '@/config/scale';
import { buildAccrualSeries } from '@/lib/leaderboard/earnings-series';

const ADDR_RE = /^0x[0-9a-fA-F]{64}$/;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/* ------------------------------ console header ---------------------------- */

/** The live half of the console header (network + connected wallet). Client-only
 *  so the server-rendered header shell can stay static. */
export function AdminStatus() {
  const mounted = useMounted();
  const acct = usePredictAccountV2();
  if (!mounted) return null;

  const net = predictV2Config.network;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center rounded-md border border-line px-2 py-1 text-[10px] uppercase tracking-wider text-text-3">
        {net}
      </span>
      {acct.owner && (
        <span className="inline-flex items-center rounded-md border border-line px-2 py-1 font-mono text-[11px] text-text-2">
          {short(acct.owner)}
        </span>
      )}
    </div>
  );
}

/* --------------------------------- panel ---------------------------------- */

export function BuilderCodePanel() {
  const mounted = useMounted();
  const acct = usePredictAccountV2();
  const admin = useBuilderCodeAdmin();
  const owned = useOwnedBuilderCodes();

  if (!mounted) return null;

  if (!acct.owner) {
    return (
      <Gate>
        <p className="text-[12px] text-text-3">Connect the team wallet to continue.</p>
      </Gate>
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
      <Gate>
        <div className="flex items-start gap-3">
          <LuShieldCheck size={18} className="mt-0.5 shrink-0 text-text-3" />
          <p className="text-[12px] leading-relaxed text-text-3">
            This page is for the Skew team. The connected wallet doesn’t have access.
          </p>
        </div>
      </Gate>
    );
  }

  // A team wallet that isn't (yet) the owner: it can register a code, or be told
  // which wallet to connect instead.
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      {builderCodeEnabled && (
        <Card>
          <div className="flex items-start gap-3">
            <LuShieldCheck size={18} className="mt-0.5 shrink-0 text-text-3" />
            <p className="text-[12px] leading-relaxed text-text-3">
              This app is attributing trades to a code owned by{' '}
              <span className="font-mono text-text-2">
                {admin.owner ? short(admin.owner) : '—'}
              </span>
              , which isn’t this wallet, so the chain won’t let you claim from it. Either
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
            the code’s owner, <span className="text-text-2">permanently</span>. There is no way to
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
                  You own a code, but the app is still attributing trades to a different one, so
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
  const fees = feesQ.data ?? [];
  const claimCount = fees.length;
  const claimedToDate = fees.reduce((s, f) => s + fromQuote(f.amount), 0);
  const unclaimed = fromQuote(claimable);
  const lifetime = unclaimed + claimedToDate;

  const recipient = dest.trim() === '' ? (owner ?? '') : dest.trim();
  const destValid = dest.trim() === '' || ADDR_RE.test(dest.trim());
  const busy = acct.busy === 'claim-builder';
  const canClaim = claimable > 0n && destValid && !busy;
  const routed = dest.trim() !== '' && destValid;

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
    <div className="flex flex-col gap-6">
      {/* KPI strip — the money at a glance, hairline-divided like an instrument panel. */}
      <div className="glass-card overflow-hidden">
        <div className="grid grid-cols-2 divide-x divide-y divide-line lg:grid-cols-4 lg:divide-y-0">
          <Stat label="Unclaimed" value={isLoading ? '—' : usd(unclaimed)} sub="accrued on-chain" hero />
          <Stat
            label="Claimed to date"
            value={feesQ.isLoading ? '—' : usd(claimedToDate)}
            sub={claimCount ? `${claimCount} ${claimCount === 1 ? 'claim' : 'claims'}` : 'no claims yet'}
          />
          <Stat
            label="Lifetime earned"
            value={isLoading || feesQ.isLoading ? '—' : usd(lifetime)}
            sub="unclaimed + claimed"
          />
          <Stat
            label="Avg per claim"
            value={claimCount ? usd(claimedToDate / claimCount) : '—'}
            sub="per sweep"
          />
        </div>
      </div>

      {/* Growth over time — cumulative lifetime earned, windowed by the range chips. */}
      <Card>
        <EarningsChart fees={fees} unclaimedNow={unclaimed} />
      </Card>

      {/* Work area — the action on the left, the context on the right. */}
      <div className="grid gap-4 lg:grid-cols-5">
        {/* Claim control */}
        <div className="lg:col-span-3">
          <Card>
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <LuCoins size={15} className="text-accent" />
                <span className="text-[13px] font-medium text-text-1">Claim builder fees</span>
              </div>
              <p className="text-[11px] leading-relaxed text-text-3">
                Sweeps everything accrued to the code. Leave the field blank to send it to the owner
                wallet, or paste any address to route it elsewhere. The destination is chosen per
                claim and isn’t stored on-chain.
              </p>

              <label className="flex flex-col gap-1.5">
                <span className="text-[10px] uppercase tracking-wider text-text-3">
                  Destination {routed ? '(custom)' : '(owner wallet)'}
                </span>
                <input
                  type="text"
                  value={dest}
                  onChange={(e) => setDest(e.target.value)}
                  placeholder={owner ?? '0x…'}
                  spellCheck={false}
                  className="glass-inset w-full rounded-lg px-3 py-2 font-mono text-[12px] text-text-1 outline-none placeholder:text-text-3/60"
                />
              </label>

              <button
                type="button"
                onClick={claim}
                disabled={!canClaim}
                className="rounded-lg border border-up/50 bg-[var(--accent-soft)] py-2.5 text-[12px] font-semibold text-accent transition-colors hover:bg-up/15 disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-text-3"
              >
                {busy
                  ? 'Confirming…'
                  : claimable > 0n
                    ? `Claim ${usd(unclaimed)}`
                    : 'Nothing to claim yet'}
              </button>

              {!destValid ? (
                <span className="text-[11px] text-down">
                  Not a valid Sui address (0x + 64 hex chars).
                </span>
              ) : (
                <span className="text-[10px] text-text-3">
                  Goes to{' '}
                  <span className="font-mono text-text-2">
                    {recipient ? short(recipient) : '—'}
                  </span>
                  .
                </span>
              )}
            </div>
          </Card>
        </div>

        {/* Code identity + claim history */}
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card>
            <div className="flex flex-col gap-3">
              <span className="eyebrow">Code</span>
              <Copyable label="Code id" value={codeId || null} />
              <Copyable label="Owner" value={owner} />
              <p className="border-t border-line pt-3 text-[10px] leading-relaxed text-text-3">
                Permanent. The owner is whoever signed the registration. There is no setter, and the
                code can’t be transferred.
              </p>
            </div>
          </Card>

          <Card>
            <div className="flex flex-col gap-3">
              <span className="eyebrow">Recent claims</span>
              <RecentClaims fees={fees} loading={feesQ.isLoading} />
            </div>
          </Card>
        </div>
      </div>

      {predictV2Config.network !== 'mainnet' && (
        <div className="flex items-start gap-3 rounded-xl border border-line bg-white/[0.015] px-4 py-3">
          <LuTriangleAlert size={16} className="mt-0.5 shrink-0 text-text-3" />
          <p className="text-[11px] leading-relaxed text-text-3">
            Testnet. At mainnet you’ll register a fresh code. Sign that one from a{' '}
            <span className="text-text-2">multisig</span>, because whoever signs it owns the fee
            revenue forever, and re-registering later would force every user to re-attach.
          </p>
        </div>
      )}
    </div>
  );
}

/* --------------------------------- pieces -------------------------------- */

function Stat({
  label,
  value,
  sub,
  hero = false,
}: {
  label: string;
  value: string;
  sub: string;
  hero?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5 p-4">
      <span className="eyebrow">{label}</span>
      <span
        className={`font-mono leading-none tabular-nums text-text-1 ${hero ? 'text-[26px]' : 'text-[18px]'}`}
      >
        {value}
      </span>
      <span className="text-[10px] text-text-3">{sub}</span>
    </div>
  );
}

function Copyable({ label, value }: { label: string; value: string | null }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] uppercase tracking-wider text-text-3">{label}</span>
      <button
        type="button"
        onClick={copy}
        disabled={!value}
        className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-text-2 transition-colors hover:text-text-1 disabled:cursor-default disabled:hover:text-text-2"
      >
        <span className="truncate">{value ? short(value) : '—'}</span>
        {value &&
          (copied ? (
            <LuCheck size={12} className="shrink-0 text-accent" />
          ) : (
            <LuCopy size={12} className="shrink-0 text-text-3" />
          ))}
      </button>
    </div>
  );
}

function RecentClaims({
  fees,
  loading,
}: {
  fees: { amount: string; checkpoint_timestamp_ms: number }[];
  loading: boolean;
}) {
  if (loading) {
    return <p className="text-[11px] text-text-3">Loading…</p>;
  }
  if (fees.length === 0) {
    return <p className="text-[11px] leading-relaxed text-text-3">No claims yet. Swept fees will show up here.</p>;
  }

  const rows = [...fees]
    .sort((a, b) => b.checkpoint_timestamp_ms - a.checkpoint_timestamp_ms)
    .slice(0, 8);

  return (
    <ul className="flex flex-col divide-y divide-line">
      {rows.map((f, i) => (
        <li key={`${f.checkpoint_timestamp_ms}-${i}`} className="flex items-center justify-between gap-3 py-1.5">
          <span className="font-mono text-[11px] tabular-nums text-text-3">
            {fmtClaimDate(f.checkpoint_timestamp_ms)}
          </span>
          <span className="font-mono text-[12px] tabular-nums text-text-1">
            +{usd(fromQuote(f.amount))}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------ earnings chart --------------------------- */

type RangeKey = '1D' | '7D' | '30D' | 'ALL';
const RANGES: { key: RangeKey; label: string; ms: number | null }[] = [
  { key: '1D', label: '1D', ms: 86_400_000 },
  { key: '7D', label: '7D', ms: 604_800_000 },
  { key: '30D', label: '30D', ms: 2_592_000_000 },
  { key: 'ALL', label: 'All', ms: null },
];

/** Cumulative lifetime earned over time. Each claim steps the running total up;
 *  a trailing point at "now" adds whatever is currently unclaimed, so the curve
 *  ends at the true lifetime. Fed the shared analytics LineChart. */
function EarningsChart({
  fees,
  unclaimedNow,
}: {
  fees: { amount: string; checkpoint_timestamp_ms: number }[];
  unclaimedNow: number;
}) {
  // Shared wall-clock (one 1s tick, purity-safe via useSyncExternalStore). The
  // panel only mounts client-side, so the seed is never shown.
  const now = useNow(0);
  const [range, setRange] = useState<RangeKey>('ALL');

  // The REAL earning cadence: every attributed trade's builder_fee at its own time,
  // reconstructed server-side and cached. Without this the chart could only plot the
  // sparse claim log, whose cumulative line is a straight ramp that implies we earn the
  // same every day. This shows the flat-while-quiet, steep-while-busy shape instead.
  const codeId = predictV2Config.builderCodeId;
  const accrualQ = useQuery({
    queryKey: ['v2', 'builder-code', 'accrual', codeId] as const,
    queryFn: async ({ signal }) => {
      const r = await fetch('/api/v2/builder-fee-accrual', { signal });
      if (!r.ok) throw new Error(`accrual ${r.status}`);
      const j = (await r.json()) as { events?: { ts: number; fee: number }[] };
      return j.events ?? [];
    },
    enabled: !!codeId,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  const accrual = accrualQ.data ?? [];

  const claimedToDate = fees.reduce((s, f) => s + fromQuote(f.amount), 0);
  const lifetime = claimedToDate + unclaimedNow;

  // Per-trade accrual is the truth; fall back to the claim log only when we couldn't
  // reconstruct it, so a read hiccup still shows the money instead of a blank.
  const full =
    accrual.length > 0
      ? buildAccrualSeries(accrual, lifetime, now)
      : fees.length > 0
        ? buildEarningsSeries(fees, unclaimedNow, now)
        : [];

  const header = (
    <div className="flex items-center justify-between gap-3">
      <span className="eyebrow">Lifetime earned</span>
      <div className="flex items-center gap-0.5 rounded-md border border-line p-0.5">
        {RANGES.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => setRange(r.key)}
            className={`rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors ${
              range === r.key ? 'bg-white/6 text-text-1' : 'text-text-3 hover:text-text-2'
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>
    </div>
  );

  let body: React.ReactNode;
  if (full.length < 2) {
    body = (
      <div className="flex h-40 items-center justify-center">
        <p className="max-w-xs text-center text-[11px] leading-relaxed text-text-3">
          Not enough history yet. The curve fills in as attributed trades earn fees.
        </p>
      </div>
    );
  } else {
    const windowMs = RANGES.find((r) => r.key === range)?.ms ?? null;
    const pts = windowEarnings(full, windowMs, now);
    body = (
      <LineChart
        points={pts}
        height={160}
        yFormat={usd}
        xCaptions={pts.length >= 2 ? [pts[0].label, pts[pts.length - 1].label] : undefined}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {header}
      {body}
    </div>
  );
}

function buildEarningsSeries(
  fees: { amount: string; checkpoint_timestamp_ms: number }[],
  unclaimedNow: number,
  now: number,
): ChartPoint[] {
  const sorted = [...fees].sort((a, b) => a.checkpoint_timestamp_ms - b.checkpoint_timestamp_ms);
  let cum = 0;
  const pts: ChartPoint[] = [];
  for (const f of sorted) {
    cum += fromQuote(f.amount);
    pts.push({ x: f.checkpoint_timestamp_ms, y: cum, label: fmtChartDate(f.checkpoint_timestamp_ms) });
  }
  // Trailing point at "now" carries the still-accruing unclaimed balance.
  pts.push({ x: now, y: cum + unclaimedNow, label: 'now' });
  return pts;
}

/** Clip to the last `windowMs`, keeping the line continuous: if claims fall
 *  before the window, seed a start point carrying the running total so the curve
 *  doesn't drop to zero at the window edge. */
function windowEarnings(all: ChartPoint[], windowMs: number | null, now: number): ChartPoint[] {
  if (windowMs == null) return all;
  const start = now - windowMs;
  const before = all.filter((p) => p.x < start);
  if (before.length === 0) return all;
  const inWin = all.filter((p) => p.x >= start);
  const baseY = before[before.length - 1].y;
  return [{ x: start, y: baseY, label: fmtChartDate(start) }, ...inWin];
}

function fmtChartDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtClaimDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="glass-card p-4">{children}</div>;
}

function Gate({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-lg">{<Card>{children}</Card>}</div>;
}
