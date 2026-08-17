/**
 * lib/autopilot/report-client.ts — client side of the verifiable Autopilot session report.
 *
 * Assembles a finished run (its config, trades with on-chain digests, and the windowed decision
 * log) into the report body, then POSTs it to /api/kelly/autopilot/report, which signs + stores
 * it on Walrus and returns the content-addressed blobId. Fail-soft: a hiccup just means no report
 * was minted this time. Types come in via `import type` so the server-only signing module (writer
 * key + Walrus SDK) is never bundled here.
 */
import type { RunResult, AutopilotLogEntry } from '@/lib/store/autopilot-store';
import type { AutopilotRules, AutopilotLimits } from '@/lib/autopilot/policy';
import type { SessionReportInput, ReportDecision, ReportTrade } from '@/lib/walrus/session-report';
import { walrusConfig } from '@/config/walrus';

/** The public, content-addressed report on Walrus — anyone can open + verify it. */
export function reportBlobUrl(blobId: string): string {
  return `${walrusConfig.aggregatorUrl}/v1/blobs/${encodeURIComponent(blobId)}`;
}

/** Assemble the report body from a finished run + the run's config + the current run log. */
export function buildSessionReportInput(args: {
  run: RunResult;
  rules: AutopilotRules;
  limits: AutopilotLimits;
  log: AutopilotLogEntry[];
}): SessionReportInput {
  const { run, rules, limits, log } = args;
  const trades: ReportTrade[] = run.trades.map((t) => ({
    marketId: t.marketId,
    side: t.side,
    ...(t.strike != null ? { strike: t.strike } : {}),
    ...(t.lower != null ? { lower: t.lower } : {}),
    ...(t.higher != null ? { higher: t.higher } : {}),
    stake: t.stake,
    entryProb: t.entryProb,
    outcome: t.outcome,
    pnlUsd: t.pnlUsd,
    at: t.at,
    digest: t.digest ?? null,
  }));
  // The bot's reasoning, best-effort: the log lines that fall inside this run's window, oldest
  // first. The rolling log may have scrolled for an older run — the trades above stay complete
  // regardless (their outcomes + digests live on the saved run).
  const decisions: ReportDecision[] = log
    .filter((e) => e.at >= run.armedAt && e.at <= run.endedAt)
    .sort((a, b) => a.at - b.at)
    .map((e) => ({
      at: e.at,
      kind: e.kind,
      text: e.text,
      ...(e.marketId ? { marketId: e.marketId } : {}),
      digest: e.digest ?? null,
    }));
  return {
    run: {
      id: run.id,
      armedAt: run.armedAt,
      endedAt: run.endedAt,
      mode: run.dryRun ? 'watch' : 'live',
      stopReason: String(run.stopReason),
      budgetUsd: run.budgetUsd,
      perTradeUsd: run.perTradeUsd,
      tradeCount: run.tradeCount,
      wins: run.wins,
      losses: run.losses,
      pendingCount: run.pendingCount,
      realizedPnlUsd: run.realizedPnlUsd,
    },
    config: {
      minEdge: rules.minEdge,
      minProb: rules.minProb,
      maxLeverage: rules.maxLeverage,
      tenors: rules.tenors.map(String),
      sides: rules.sides.map(String),
      maxTrades: limits.maxTrades,
      maxConcurrent: limits.maxConcurrent,
      cooldownMs: limits.cooldownMs,
      maxConsecutiveLosses: limits.maxConsecutiveLosses,
      armDurationMs: limits.armDurationMs,
    },
    trades,
    decisions,
  };
}

/** Mint the signed report. Returns the Walrus blobId, or null on any failure (fail-soft). */
export async function mintSessionReport(input: SessionReportInput): Promise<string | null> {
  try {
    const res = await fetch('/api/kelly/autopilot/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { ok?: boolean; blobId?: string };
    return json.ok && typeof json.blobId === 'string' ? json.blobId : null;
  } catch {
    return null;
  }
}
