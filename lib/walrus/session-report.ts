/**
 * lib/walrus/session-report.ts — a signed, verifiable Autopilot SESSION REPORT on Walrus.
 *
 * When an unattended Autopilot run finishes, the trader can mint ONE report that captures the
 * whole run: its config (the rules + limits it ran under), every trade with its outcome + PnL +
 * on-chain tx digest, the decision log, and the run summary. Like a call receipt it is:
 *   - IMMUTABLE + CONTENT-ADDRESSED — Walrus returns a blobId that is the hash of the bytes.
 *   - SIGNED BY KELLY — an Ed25519 signature (writer key) over the canonical bytes, so anyone
 *     can confirm it was authored here and never altered after the fact.
 *   - CROSS-CHECKABLE — each real trade carries its Sui tx digest, so a skeptic can verify the
 *     bot actually placed it on-chain.
 *
 * It's the "here's exactly what the bot did while you were away" artifact. SERVER-ONLY (signs
 * with the writer key); the report shape is shared with the client via `import type`. Builds on
 * the Phase 0 blob layer ([[walrus-phase0]]) and mirrors lib/walrus/receipts.ts.
 */
import { toBase64 } from '@mysten/sui/utils';
import { storeJson, getWriterKeypair } from '@/lib/walrus/client';
import { walrusConfig } from '@/config/walrus';
import { stableStringify } from '@/lib/walrus/receipts';

export type ReportOutcome = 'won' | 'lost' | 'pending';
export type ReportSide = 'up' | 'down' | 'range';

/** One trade the bot made in the run (or let go pending), with its on-chain proof. */
export interface ReportTrade {
  marketId: string;
  side: ReportSide;
  strike?: number;
  lower?: number;
  higher?: number;
  stake: number;
  entryProb: number;
  outcome: ReportOutcome;
  pnlUsd: number;
  at: number;
  /** On-chain tx digest of the placement (null for a watch-mode sim). */
  digest?: string | null;
}

/** One line from the run log — the bot's plain-language reasoning as it went. */
export interface ReportDecision {
  at: number;
  kind: string;
  text: string;
  marketId?: string;
  digest?: string | null;
}

/** The run's headline facts. */
export interface SessionRunSummary {
  id: string;
  armedAt: number;
  endedAt: number;
  /** 'watch' = a simulated (no-signing) run, 'live' = real money. */
  mode: 'watch' | 'live';
  stopReason: string;
  budgetUsd: number;
  perTradeUsd: number;
  tradeCount: number;
  wins: number;
  losses: number;
  pendingCount: number;
  realizedPnlUsd: number;
}

/** The rules + limits the run operated under (its guardrails). */
export interface SessionReportConfig {
  minEdge: number;
  minProb: number;
  maxLeverage: number;
  tenors: string[];
  sides: string[];
  maxTrades: number;
  maxConcurrent: number;
  cooldownMs: number;
  maxConsecutiveLosses: number;
  armDurationMs: number;
}

/** The client-attested body of a report (what the bot did), minus the signed wrapper. */
export interface SessionReportInput {
  run: SessionRunSummary;
  config: SessionReportConfig;
  trades: ReportTrade[];
  decisions: ReportDecision[];
}

/** The signable core: the input plus Kelly's server-stamped authorship metadata. */
export interface SessionReportCore extends SessionReportInput {
  version: 1;
  author: 'kelly-autopilot';
  /** ms epoch the report was minted (server-stamped, not client-trusted). */
  createdAt: number;
}

/** A full report: the signed core plus the authorship proof, stored on Walrus. */
export interface SessionReport extends SessionReportCore {
  /** Base64 Ed25519 signature over reportBytes(core). */
  signature: string;
  /** Base64 writer public key — verify the signature against this. */
  publicKey: string;
  /** Writer Sui address (must equal publicKey.toSuiAddress()). */
  signerAddress: string;
}

/** The exact bytes the signature covers (recursively key-sorted, so sign == verify). */
export function reportBytes(core: SessionReportCore): Uint8Array {
  return new TextEncoder().encode(stableStringify(core));
}

/**
 * Sign an Autopilot session report with Kelly's writer key and store it on Walrus. Returns the
 * content-addressed blobId — the public, tamper-proof handle to the run. Server-only (signs with
 * the writer key); throws if the writer key isn't configured.
 */
export async function mintSessionReport(input: SessionReportInput): Promise<{ blobId: string }> {
  const keypair = getWriterKeypair();
  const core: SessionReportCore = { version: 1, author: 'kelly-autopilot', createdAt: Date.now(), ...input };
  const signature = toBase64(await keypair.sign(reportBytes(core)));
  const report: SessionReport = {
    ...core,
    signature,
    publicKey: keypair.getPublicKey().toBase64(),
    signerAddress: keypair.toSuiAddress(),
  };
  const { blobId } = await storeJson(report, { epochs: walrusConfig.defaultEpochs, deletable: false });
  return { blobId };
}
