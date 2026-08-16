'use client';

/**
 * KellyTrackRecordPanel — Kelly's public, verifiable scoreboard.
 *
 * Every concrete call Kelly makes (a bet/range recommendation) is signed and written to
 * Walrus the moment it lands (see lib/walrus/receipts.ts). This page reads that log back
 * (GET /api/kelly/receipts → fetchTrackRecord), scores each call against on-chain settlement,
 * and shows the record: win rate, won/lost/pending, and every call with a "Verify" link that
 * opens the original signed receipt on the public Walrus aggregator. It's the trust-and-
 * marketing surface for the receipts phase — nothing here can be edited after the fact.
 *
 * House style matches the Leaderboard panel: max-w-5xl container, glass cards, mono numerals,
 * teal (up) / coral (down) semantics, hairline dividers.
 */
import Image from 'next/image';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { IconType } from 'react-icons';
import {
  LuBadgeCheck,
  LuShieldCheck,
  LuTarget,
  LuCircleCheck,
  LuCircleX,
  LuClock,
  LuArrowUpRight,
  LuSparkles,
  LuShare2,
  LuRefreshCw,
} from 'react-icons/lu';
import { fetchTrackRecord, type TrackRecordCall } from '@/lib/copilot/receipts-client';
import { walrusConfig } from '@/config/walrus';
import { MASCOT_SRC } from '@/lib/mascot';
import { useNow } from '@/lib/hooks/use-now';
import { num } from '@/lib/format';

/** The public, content-addressed receipt on Walrus — anyone can open + verify it. */
const blobUrl = (blobId: string) => `${walrusConfig.aggregatorUrl}/v1/blobs/${encodeURIComponent(blobId)}`;

/** Compact "2m ago" from a ms timestamp. */
function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return `${Math.floor(d / 7)}w ago`;
}

export function KellyTrackRecordPanel() {
  const now = useNow(60_000);
  const q = useQuery({
    queryKey: ['kelly', 'track-record'],
    queryFn: () => fetchTrackRecord(60),
    staleTime: 20_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  const data = q.data ?? null;
  const calls = data?.calls ?? [];
  const wr = data?.winRate ?? null;
  const loadingEmpty = q.isLoading && !data;

  function share() {
    const wrTxt = wr == null ? '' : ` Win rate so far: ${Math.round(wr * 100)}%.`;
    const url = typeof window !== 'undefined' ? `${window.location.origin}/v2/track-record` : '';
    const text = `Kelly calls BTC and signs every prediction to Walrus the second it's made — no edits after the fact.${wrTxt} See the receipts:`;
    const intent = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
    window.open(intent, '_blank', 'noopener,noreferrer');
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-5">
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="glass-card mb-5 flex flex-col gap-5 overflow-hidden p-5 sm:flex-row sm:items-center sm:gap-6 sm:p-6">
        <div className="relative mx-auto flex h-24 w-24 flex-none items-center justify-center sm:mx-0 sm:h-28 sm:w-28">
          <span
            aria-hidden
            className="absolute inset-0"
            style={{ background: 'radial-gradient(circle at 50% 42%, var(--accent-soft), transparent 70%)' }}
          />
          <Image src={MASCOT_SRC.won} alt="Kelly the fox" width={112} height={112} className="relative h-full w-full object-contain" />
        </div>

        <div className="min-w-0 flex-1">
          <p className="eyebrow mb-1 flex items-center gap-1.5">
            <LuBadgeCheck size={12} className="text-accent" /> Kelly · verifiable calls
          </p>
          <h1 className="text-[22px] font-semibold tracking-tight text-text-1 sm:text-[26px]">Kelly&rsquo;s Track Record</h1>
          <p className="mt-1.5 max-w-xl text-[12.5px] leading-relaxed text-text-2">
            Every prediction Kelly makes is signed and written to Walrus the moment it lands, so it can&rsquo;t be edited
            after the fact. Here&rsquo;s how the calls have played out.
          </p>
        </div>

        <div className="flex flex-none items-center justify-between gap-4 sm:flex-col sm:items-end sm:gap-3">
          <div className="text-right">
            <div
              className={`font-mono text-[34px] leading-none tracking-tight sm:text-[40px] ${
                wr == null ? 'text-text-3' : wr >= 0.5 ? 'text-up' : 'text-down'
              }`}
            >
              {wr == null ? '—' : `${Math.round(wr * 100)}%`}
            </div>
            <p className="eyebrow mt-1.5">Win rate</p>
          </div>
          <button
            onClick={share}
            className="group glass-inset inline-flex items-center gap-1.5 px-3 py-2 text-[11px] font-medium text-text-2 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1"
          >
            <LuShare2 size={12} className="transition-colors duration-200 group-hover:text-accent" />
            Share
          </button>
        </div>
      </div>

      {/* ── Stats ────────────────────────────────────────────────────────── */}
      <div className="mb-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <StatCard icon={LuTarget} color="#6aa6e6" label="Calls made" loading={loadingEmpty} value={num(data?.total ?? 0, 0)} />
        <StatCard icon={LuCircleCheck} color="var(--up)" label="Won" loading={loadingEmpty} value={num(data?.won ?? 0, 0)} valueClass="text-up" />
        <StatCard icon={LuCircleX} color="var(--down)" label="Lost" loading={loadingEmpty} value={num(data?.lost ?? 0, 0)} valueClass="text-down" />
        <StatCard icon={LuClock} color="#9aa4af" label="Awaiting settle" loading={loadingEmpty} value={num(data?.pending ?? 0, 0)} />
      </div>

      {/* ── Feed header ──────────────────────────────────────────────────── */}
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-[13px] font-semibold text-text-1">Recent calls</h2>
        {data && data.total > 0 && (
          <span className="rounded-full bg-bg-3 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-text-2">{data.total}</span>
        )}
        <button
          onClick={() => void q.refetch()}
          disabled={q.isFetching}
          aria-label="Refresh"
          title="Refresh the track record"
          className="group glass-inset ml-auto inline-flex items-center justify-center p-1.5 text-text-2 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <LuRefreshCw size={12} className={`transition-colors duration-200 group-hover:text-accent ${q.isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* ── Feed ─────────────────────────────────────────────────────────── */}
      <div className="glass-card overflow-hidden">
        <div className="rows-divided">
          {loadingEmpty ? (
            <FeedSkeleton />
          ) : q.isError ? (
            <div className="px-4 py-12 text-center text-[13px] text-text-2">
              I couldn&rsquo;t load the track record just now. Give it a moment and refresh.
            </div>
          ) : calls.length === 0 ? (
            <EmptyState />
          ) : (
            calls.map((c) => <CallRow key={c.id} call={c} now={now} />)
          )}
        </div>
      </div>

      {/* ── Footer note ──────────────────────────────────────────────────── */}
      <p className="mt-4 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-text-3">
        <LuShieldCheck size={12} className="mt-px flex-none text-text-3" />
        <span>
          Each receipt is content-addressed and signed by Kelly. <span className="text-text-2">Verify</span> opens the
          original on the public Walrus network, exactly as it was written. Outcomes are scored against on-chain
          settlement, so a call stays <span className="text-text-2">Awaiting settle</span> until its market settles.
        </span>
      </p>
    </div>
  );
}

/* ------------------------------- pieces ---------------------------------- */

function StatCard({
  icon: Icon,
  color,
  label,
  value,
  valueClass,
  loading = false,
}: {
  icon: IconType;
  color: string;
  label: string;
  value: React.ReactNode;
  valueClass?: string;
  loading?: boolean;
}) {
  return (
    <div className="glass-inset flex min-w-0 flex-col gap-2 p-3 sm:p-4">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="inline-flex h-[22px] w-[22px] flex-none items-center justify-center rounded-md"
          style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}
        >
          <Icon size={13} />
        </span>
        <span className="eyebrow">{label}</span>
      </div>
      {loading ? (
        <span className="h-4 w-12 rounded skeleton sm:h-5 sm:w-16" />
      ) : (
        <span className={`font-mono text-[16px] leading-none tabular-nums tracking-tight sm:text-[20px] ${valueClass ?? 'text-text-1'}`}>
          {value}
        </span>
      )}
    </div>
  );
}

function CallRow({ call, now }: { call: TrackRecordCall; now: number }) {
  function shareCall() {
    const url = typeof window !== 'undefined' ? `${window.location.origin}/v2/track-record/${call.blobId}` : '';
    const text = `Kelly's call, signed to Walrus the moment it was made: ${call.summary}`;
    window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, '_blank', 'noopener,noreferrer');
  }
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3.5">
      <div className="min-w-0">
        <p className="truncate font-mono text-[13px] text-text-1">{call.summary}</p>
        <p className="mt-0.5 text-[10.5px] tabular-nums text-text-3">{ago(call.createdAt, now)}</p>
      </div>
      <div className="flex items-center gap-1.5 sm:gap-2">
        <OutcomePill outcome={call.outcome} />
        <button
          onClick={shareCall}
          title="Share this call"
          aria-label="Share this call"
          className="group glass-inset inline-flex h-6 w-6 flex-none items-center justify-center text-text-3 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1"
        >
          <LuShare2 size={11} className="transition-colors duration-200 group-hover:text-accent" />
        </button>
        <VerifyLink blobId={call.blobId} />
      </div>
    </div>
  );
}

function OutcomePill({ outcome }: { outcome: TrackRecordCall['outcome'] }) {
  const map = {
    won: { label: 'Won', cls: 'bg-(--accent-soft) text-up', Icon: LuCircleCheck },
    lost: { label: 'Lost', cls: 'bg-(--down-soft) text-down', Icon: LuCircleX },
    pending: { label: 'Pending', cls: 'bg-white/5 text-text-3', Icon: LuClock },
  }[outcome];
  const { label, cls, Icon } = map;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${cls}`}>
      <Icon size={11} />
      {label}
    </span>
  );
}

function VerifyLink({ blobId }: { blobId: string }) {
  return (
    <a
      href={blobUrl(blobId)}
      target="_blank"
      rel="noreferrer"
      title="Open the signed receipt on Walrus"
      className="group glass-inset inline-flex items-center gap-1 px-2 py-1 text-[10.5px] font-medium text-text-2 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1"
    >
      <LuShieldCheck size={11} className="text-text-3 transition-colors duration-200 group-hover:text-accent" />
      <span className="hidden sm:inline">Verify</span>
      <LuArrowUpRight size={10} className="text-text-3 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
    </a>
  );
}

function FeedSkeleton() {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3.5">
          <div className="min-w-0">
            <span className="block h-3.5 w-48 rounded skeleton" />
            <span className="mt-1.5 block h-2.5 w-16 rounded skeleton" />
          </div>
          <div className="flex items-center gap-2.5">
            <span className="h-5 w-14 rounded-full skeleton" />
            <span className="h-6 w-14 rounded skeleton" />
          </div>
        </div>
      ))}
    </>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
      <div className="relative h-16 w-16">
        <span
          aria-hidden
          className="absolute inset-0"
          style={{ background: 'radial-gradient(circle at 50% 42%, var(--accent-soft), transparent 70%)' }}
        />
        <Image src={MASCOT_SRC.thinking} alt="" width={64} height={64} className="relative h-full w-full object-contain" />
      </div>
      <p className="text-[13px] text-text-1">No calls on the record yet.</p>
      <p className="max-w-sm text-[12px] leading-relaxed text-text-2">
        Ask Kelly to analyze BTC and set up a bet. Every call it makes gets signed and logged here, so the track record
        builds itself as you trade.
      </p>
      <Link
        href="/v2/copilot"
        className="group glass-inset mt-1 inline-flex items-center gap-1.5 px-3 py-2 text-[11px] font-medium text-text-2 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1"
      >
        <LuSparkles size={12} className="transition-colors duration-200 group-hover:text-accent" />
        Ask Kelly
      </Link>
    </div>
  );
}
