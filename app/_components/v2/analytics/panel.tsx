'use client';

/**
 * V2AnalyticsPanel — the Analytics screen for the new deployment, a 1:1 match of
 * the legacy AnalyticsPanel: header, a glass tool-switcher, and a single keyed
 * content area (one instrument at a time, restrained `rise` on switch). The tool
 * set mirrors legacy — Pulse · Markets · Sentiment · Price swings · Live bets.
 *
 * Real inputs: the live market list, cadence, expiry and (when available) live
 * spot. Sample inputs: volume, sentiment, IV and the bet feed — all clearly
 * labelled, generated deterministically (seeded server-side) so hydration is
 * stable. Each view swaps to real data by replacing its demo generator once the
 * indexer exposes global flow.
 */
import { useState } from 'react';
import { LuChartNoAxesCombined } from 'react-icons/lu';
import { predictV2Config } from '@/config/predict';
import {
  demoMarketCells,
  demoKpis,
  demoSentiment,
  demoFlowRows,
} from '@/lib/api/v2/analytics-demo';
import type { V2Market } from '@/lib/api/v2/types';
import { V2AnalyticsToolbar, type V2AnalyticsTool } from './toolbar';
import { V2Pulse, V2MarketsTool, V2SentimentTool, V2VolTool } from './tools';
import { V2FlowTape } from './flow-tape';

export function V2AnalyticsPanel({
  markets,
  serverNow,
  seed,
  spot,
}: {
  markets: V2Market[];
  serverNow: number;
  seed: number;
  spot: number | null;
}) {
  const [tool, setTool] = useState<V2AnalyticsTool>('pulse');

  // Deterministic sample datasets (seeded server-side → stable hydration). The
  // market list / cadence / expiry are real; the metrics are illustrative.
  const cells = demoMarketCells(markets, spot, serverNow, seed);
  const kpis = demoKpis(cells, markets.length, serverNow, seed);
  const sentiment = demoSentiment(serverNow, seed);
  const flow = demoFlowRows(16, serverNow, seed);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-5">
      <div className="mb-4">
        <h1 className="flex items-center gap-2 text-[20px] font-semibold tracking-tight text-text-1">
          <LuChartNoAxesCombined size={18} className="text-accent" />
          Analytics
        </h1>
        <p className="mt-1 text-[12px] text-text-3">
          See what everyone’s betting on right now — live markets, sentiment, and price swings.
          Market counts are live; the activity views preview with sample data until the global feed
          is indexed · {predictV2Config.network}
        </p>
      </div>

      <V2AnalyticsToolbar active={tool} onSelect={setTool} />

      <div key={tool} className="rise">
        {tool === 'pulse' && <V2Pulse kpis={kpis} cells={cells} sentiment={sentiment} flow={flow} />}
        {tool === 'markets' && <V2MarketsTool cells={cells} />}
        {tool === 'sentiment' && <V2SentimentTool sentiment={sentiment} cells={cells} />}
        {tool === 'vol' && <V2VolTool cells={cells} />}
        {tool === 'flow' && <V2FlowTape initial={flow} title="Live bets" />}
      </div>
    </div>
  );
}
