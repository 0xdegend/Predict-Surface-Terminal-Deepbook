'use client';

/**
 * The Results tab: saved runs, their trades, and the verifiable session report.
 *
 * Split out of autopilot-panel.tsx.
 */
import { useState } from 'react';
import { LuChevronDown, LuExternalLink, LuEye, LuHistory, LuInbox, LuRadioTower, LuShare2, LuShieldCheck, LuTrash2 } from 'react-icons/lu';
import { num } from '@/lib/format';
import { type RunResult, type RunTradeResult, useAutopilotStore } from '@/lib/store/autopilot-store';
import { stopReasonLabel } from '@/lib/autopilot/policy';
import { buildSessionReportInput, mintSessionReport, reportBlobUrl } from '@/lib/autopilot/report-client';
import { pnlClass, signedUsd } from './shared';

// The verifiable session report reuses the Walrus writer-key infra behind the receipts flag,
// so it only shows where that's configured (the route 503s otherwise).
const KELLY_RECEIPTS = process.env.NEXT_PUBLIC_KELLY_RECEIPTS === '1';

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function ResultsView({
  history,
  onDelete,
  onClear,
}: {
  history: RunResult[];
  onDelete: (id: string) => void;
  onClear: () => void;
}) {
  if (history.length === 0) {
    return (
      <div className="glass-card flex flex-col items-center gap-2 px-4 py-14 text-center">
        <LuInbox size={24} className="text-text-3" />
        <p className="text-[13px] text-text-1">No finished runs yet.</p>
        <p className="max-w-xs text-[12px] leading-relaxed text-text-2">
          Start Autopilot from the Autopilot tab. When a run ends, its results are saved here so you can see how Kelly did
          over time.
        </p>
      </div>
    );
  }
  const net = history.reduce((a, r) => a + r.realizedPnlUsd, 0);
  const wins = history.reduce((a, r) => a + r.wins, 0);
  const losses = history.reduce((a, r) => a + r.losses, 0);
  const resolved = wins + losses;
  return (
    <div className="flex flex-col gap-3">
      {/* All-time summary across saved runs */}
      <div className="glass-card flex items-center justify-between gap-3 p-4">
        <div className="flex flex-col gap-0.5">
          <span className="eyebrow flex items-center gap-1.5">
            <LuHistory size={12} className="text-accent" /> All-time results
          </span>
          <span className={`font-mono text-[22px] font-semibold leading-none tabular-nums ${pnlClass(net)}`}>
            {signedUsd(net)}
          </span>
          <span className="font-mono text-[11px] tabular-nums text-text-3">
            {history.length} run{history.length === 1 ? '' : 's'} · {wins}W / {losses}L
            {resolved > 0 ? ` · ${Math.round((wins / resolved) * 100)}%` : ''}
          </span>
        </div>
        <button
          onClick={onClear}
          className="group glass-inset inline-flex items-center gap-1.5 px-3 py-2 text-[11px] font-medium text-text-2 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1"
        >
          <LuTrash2 size={12} className="transition-colors duration-200 group-hover:text-accent" /> Clear all
        </button>
      </div>

      {/* One card per finished run */}
      <div className="flex flex-col gap-2.5">
        {history.map((r) => (
          <RunResultCard key={r.id} r={r} onDelete={() => onDelete(r.id)} />
        ))}
      </div>
    </div>
  );
}

function RunResultCard({ r, onDelete }: { r: RunResult; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const resolved = r.wins + r.losses;
  const stopLabel = r.stopReason === 'manual' ? 'You stopped it' : stopReasonLabel(r.stopReason);
  return (
    <div className="glass-card overflow-hidden">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12.5px] tabular-nums text-text-1">{fmtWhen(r.endedAt)}</span>
            <ModeChip dryRun={r.dryRun} />
          </div>
          <div className="mt-0.5 truncate font-mono text-[10.5px] tabular-nums text-text-3">
            {r.tradeCount} trade{r.tradeCount === 1 ? '' : 's'} · {r.wins}W/{r.losses}L
            {resolved > 0 ? ` · ${Math.round((r.wins / resolved) * 100)}%` : ''}
            {r.pendingCount > 0 ? ` · ${r.pendingCount} pending` : ''} · {stopLabel}
          </div>
        </div>
        <span className={`flex-none font-mono text-[15px] font-semibold tabular-nums ${pnlClass(r.realizedPnlUsd)}`}>
          {signedUsd(r.realizedPnlUsd)}
        </span>
        <LuChevronDown size={15} className={`flex-none text-text-3 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-white/6">
          {r.trades.length === 0 ? (
            <p className="px-4 py-3 text-[11.5px] text-text-3">No trades recorded for this run.</p>
          ) : (
            <div className="rows-divided max-h-80 overflow-y-auto">
              {r.trades.map((t, i) => (
                <ResultTradeRow key={`${t.marketId}-${t.at}-${i}`} t={t} />
              ))}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 border-t border-white/6 px-3 py-2">
            {KELLY_RECEIPTS ? <ReportControl r={r} /> : <span />}
            <button
              onClick={onDelete}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10.5px] font-medium text-text-3 transition-colors hover:text-down"
            >
              <LuTrash2 size={11} /> Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Mint / open the run's verifiable session report. Not yet minted → a "Sign this run to Walrus"
 * button that assembles the report (config + trades + digests + decision log) and stores it,
 * signed by Kelly, immutably. Minted → a Verify link (opens the signed blob on the public Walrus
 * aggregator) + a Share button. On-demand so the trader mints once the run has fully settled.
 */
function ReportControl({ r }: { r: RunResult }) {
  const attachReport = useAutopilotStore((s) => s.attachReport);
  const [minting, setMinting] = useState(false);

  async function mint() {
    if (minting) return;
    setMinting(true);
    try {
      const { log, rules, limits } = useAutopilotStore.getState();
      const blobId = await mintSessionReport(buildSessionReportInput({ run: r, rules, limits, log }));
      if (blobId) attachReport(r.id, blobId);
    } finally {
      setMinting(false);
    }
  }

  function share() {
    if (!r.reportBlobId) return;
    const url = reportBlobUrl(r.reportBlobId);
    const net = r.realizedPnlUsd;
    const line = `Here's exactly what my Skew Autopilot did while I was away: ${r.tradeCount} trades, ${r.wins}W/${r.losses}L, ${net >= 0 ? '+' : '-'}$${Math.abs(net) % 1 === 0 ? Math.abs(net).toFixed(0) : Math.abs(net).toFixed(2)}. Signed to Walrus, no edits:`;
    window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(line)}&url=${encodeURIComponent(url)}`, '_blank', 'noopener,noreferrer');
  }

  if (r.reportBlobId) {
    return (
      <div className="flex items-center gap-1.5">
        <a
          href={reportBlobUrl(r.reportBlobId)}
          target="_blank"
          rel="noreferrer"
          title="Open the signed report on Walrus"
          className="group glass-inset inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10.5px] font-medium text-text-2 transition-all hover:border-(--accent-line) hover:text-text-1"
        >
          <LuShieldCheck size={11} className="text-up" /> Verify on Walrus
          <LuExternalLink size={10} className="text-text-3" />
        </a>
        <button
          onClick={share}
          title="Share this run"
          aria-label="Share this run"
          className="group glass-inset inline-flex h-6.5 w-6.5 items-center justify-center rounded-md text-text-3 transition-all hover:border-(--accent-line) hover:text-text-1"
        >
          <LuShare2 size={11} />
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => void mint()}
      disabled={minting}
      className="group glass-inset inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10.5px] font-medium text-text-2 transition-all hover:border-(--accent-line) hover:text-text-1 disabled:opacity-60"
    >
      {minting ? (
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-accent" />
      ) : (
        <LuShieldCheck size={11} className="transition-colors group-hover:text-accent" />
      )}
      {minting ? 'Signing to Walrus…' : 'Sign this run to Walrus'}
    </button>
  );
}

function ModeChip({ dryRun }: { dryRun: boolean }) {
  return dryRun ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-white/6 px-1.5 py-px text-[9.5px] font-medium text-text-3">
      <LuEye size={9} /> Watch
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-(--up-soft) px-1.5 py-px text-[9.5px] font-medium text-up">
      <LuRadioTower size={9} /> Live
    </span>
  );
}

function ResultTradeRow({ t }: { t: RunTradeResult }) {
  const dir = t.side === 'range' ? 'RANGE' : t.side.toUpperCase();
  const dirCls = t.side === 'up' ? 'text-up' : t.side === 'down' ? 'text-down' : 'text-text-1';
  const label = t.side === 'range' ? `$${num(t.lower ?? 0, 0)}–$${num(t.higher ?? 0, 0)}` : `$${num(t.strike ?? 0, 0)}`;
  return (
    <div className="flex items-center gap-2.5 px-4 py-2">
      <span className={`w-12 flex-none font-mono text-[11px] font-semibold ${dirCls}`}>{dir}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] tabular-nums text-text-1">
        {label} <span className="text-text-3">· ${num(t.stake, 0)} · {Math.round(t.entryProb * 100)}%</span>
      </span>
      <OutcomeChip outcome={t.outcome} />
      <span
        className={`w-16 flex-none text-right font-mono text-[12px] tabular-nums ${
          t.outcome === 'pending' ? 'text-text-3' : pnlClass(t.pnlUsd)
        }`}
      >
        {t.outcome === 'pending' ? '—' : signedUsd(t.pnlUsd)}
      </span>
    </div>
  );
}

function OutcomeChip({ outcome }: { outcome: RunTradeResult['outcome'] }) {
  const map = {
    won: { label: 'Won', cls: 'bg-(--up-soft) text-up' },
    lost: { label: 'Lost', cls: 'bg-(--down-soft) text-down' },
    pending: { label: 'Pending', cls: 'bg-white/6 text-text-3' },
  }[outcome];
  return <span className={`flex-none rounded-full px-1.5 py-px text-[9.5px] font-medium ${map.cls}`}>{map.label}</span>;
}
