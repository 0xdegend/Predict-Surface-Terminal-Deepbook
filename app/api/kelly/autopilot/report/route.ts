/**
 * /api/kelly/autopilot/report — mint a signed, verifiable Autopilot SESSION REPORT on Walrus.
 *
 * POST → sign the run the client attests (its config, trades with on-chain digests, decision
 *        log, and summary) with Kelly's writer key and store it on Walrus. Returns { blobId },
 *        the public content-addressed handle: anyone can open it on the aggregator and confirm
 *        the signature + that the bytes were never altered.
 *
 * The report is a record of what the bot did on THIS device, so the body is client-attested;
 * the per-trade Sui tx digests are the on-chain cross-check, and Kelly's signature + the Walrus
 * hash make it tamper-proof and timestamped. Ships behind WALRUS_WRITER_KEY (503 without it).
 * The input is strictly sanitized (arrays capped, strings truncated, enums coerced) so a caller
 * can't balloon the blob or inject junk.
 */
import { NextResponse } from 'next/server';
import {
  mintSessionReport,
  type SessionReportInput,
  type ReportTrade,
  type ReportDecision,
  type ReportSide,
  type ReportOutcome,
} from '@/lib/walrus/session-report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_TRADES = 200;
const MAX_DECISIONS = 300;
const MAX_TEXT = 200;

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const numOr = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const intOr = (v: unknown): number => Math.trunc(numOr(v));
const str = (v: unknown, max: number): string => String(v ?? '').slice(0, max);
const side = (v: unknown): ReportSide => (v === 'up' || v === 'down' ? v : v === 'range' ? 'range' : 'range');
const outcome = (v: unknown): ReportOutcome => (v === 'won' || v === 'lost' ? v : 'pending');
const digest = (v: unknown): string | null => (typeof v === 'string' && v ? v.slice(0, 100) : null);

function sanitizeTrade(raw: unknown): ReportTrade {
  const t = asRecord(raw);
  const trade: ReportTrade = {
    marketId: str(t.marketId, 80),
    side: side(t.side),
    stake: numOr(t.stake),
    entryProb: numOr(t.entryProb),
    outcome: outcome(t.outcome),
    pnlUsd: numOr(t.pnlUsd),
    at: numOr(t.at),
    digest: digest(t.digest),
  };
  if (t.strike != null) trade.strike = numOr(t.strike);
  if (t.lower != null) trade.lower = numOr(t.lower);
  if (t.higher != null) trade.higher = numOr(t.higher);
  return trade;
}

function sanitizeDecision(raw: unknown): ReportDecision {
  const d = asRecord(raw);
  const decision: ReportDecision = { at: numOr(d.at), kind: str(d.kind, 20), text: str(d.text, MAX_TEXT), digest: digest(d.digest) };
  if (d.marketId) decision.marketId = str(d.marketId, 80);
  return decision;
}

function sanitize(body: Record<string, unknown>): SessionReportInput | null {
  const run = asRecord(body.run);
  const config = asRecord(body.config);
  const id = str(run.id, 64);
  if (!id) return null;
  const arr = (v: unknown, cap: number, max: number): string[] =>
    Array.isArray(v) ? v.slice(0, cap).map((x) => str(x, max)) : [];
  return {
    run: {
      id,
      armedAt: numOr(run.armedAt),
      endedAt: numOr(run.endedAt),
      mode: run.mode === 'live' ? 'live' : 'watch',
      stopReason: str(run.stopReason, 40),
      budgetUsd: numOr(run.budgetUsd),
      perTradeUsd: numOr(run.perTradeUsd),
      tradeCount: intOr(run.tradeCount),
      wins: intOr(run.wins),
      losses: intOr(run.losses),
      pendingCount: intOr(run.pendingCount),
      realizedPnlUsd: numOr(run.realizedPnlUsd),
    },
    config: {
      minEdge: numOr(config.minEdge),
      minProb: numOr(config.minProb),
      maxLeverage: numOr(config.maxLeverage),
      tenors: arr(config.tenors, 12, 24),
      sides: arr(config.sides, 8, 12),
      maxTrades: intOr(config.maxTrades),
      maxConcurrent: intOr(config.maxConcurrent),
      cooldownMs: numOr(config.cooldownMs),
      maxConsecutiveLosses: intOr(config.maxConsecutiveLosses),
      armDurationMs: numOr(config.armDurationMs),
    },
    trades: Array.isArray(body.trades) ? body.trades.slice(0, MAX_TRADES).map(sanitizeTrade) : [],
    decisions: Array.isArray(body.decisions) ? body.decisions.slice(0, MAX_DECISIONS).map(sanitizeDecision) : [],
  };
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!process.env.WALRUS_WRITER_KEY) {
    return NextResponse.json({ ok: false, error: 'unconfigured' }, { status: 503 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }
  const input = sanitize(body);
  if (!input) return NextResponse.json({ ok: false, error: 'invalid_report' }, { status: 400 });
  try {
    const { blobId } = await mintSessionReport(input);
    return NextResponse.json({ ok: true, blobId });
  } catch {
    return NextResponse.json({ ok: false, error: 'store_failed' }, { status: 502 });
  }
}
