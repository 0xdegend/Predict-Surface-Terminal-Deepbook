'use client';

/**
 * V2AnalyticsPanel — the Analytics screen for the new deployment, a 1:1 match of
 * the legacy AnalyticsPanel: header, a glass tool-switcher, and a single keyed
 * content area (one instrument at a time, restrained `rise` on switch). The tool
 * set mirrors legacy — Pulse · Markets · Sentiment · Price swings · Live bets.
 *
 * All data is REAL, reconstructed from the per-market feeds via useV2Analytics
 * (there is no global flow endpoint, so it fans out across the active markets):
 * volume + bet counts from the activity rollups, direction/sentiment/flow from the
 * order events, implied vol from the live pricer.
 *
 * The Trader-styles roster is the ONE exception: it needs the whole retained
 * ~8h window (not just the tight live window the flow tape uses), so it comes
 * from its own cached server route via useV2TraderStylesRoster, fetched lazily
 * only while that tab is open.
 */
import { useState } from 'react';
import { LuChartNoAxesCombined } from 'react-icons/lu';
import { predictV2Config } from '@/config/predict';
import { useV2Analytics } from '@/lib/hooks/use-v2-analytics';
import { useV2TraderStylesRoster } from '@/lib/hooks/use-v2-trader-styles-roster';
import type { V2Market } from '@/lib/api/v2/types';
import { V2AnalyticsToolbar, type V2AnalyticsTool } from './toolbar';
import { V2Pulse, V2MarketsTool, V2SentimentTool, V2VolTool } from './tools';
import { V2StylesTool } from './styles-tool';
import { V2FlowTape } from './flow-tape';

export function V2AnalyticsPanel({
  markets,
  spot,
}: {
  markets: V2Market[];
  spot: number | null;
}) {
  const [tool, setTool] = useState<V2AnalyticsTool>('pulse');
  const { cells, kpis, sentiment, flow, isLoading } = useV2Analytics(markets, spot);
  // Own the roster separately (whole retained window, cached server-side); only
  // fan it out once the trader actually opens the Styles tab.
  const roster = useV2TraderStylesRoster({ enabled: tool === 'styles' });

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-5">
      <div className="mb-4">
        <h1 className="flex items-center gap-2 text-[20px] font-semibold tracking-tight text-text-1">
          <LuChartNoAxesCombined size={18} className="text-accent" />
          Analytics
        </h1>
        <p className="mt-1 text-[12px] text-text-3">
          See what everyone’s betting on right now: live bets, market sentiment, and how prices are
          moving · {predictV2Config.network}
        </p>
      </div>

      <V2AnalyticsToolbar active={tool} onSelect={setTool} />

      {isLoading ? (
        <div className="glass-card h-64 animate-pulse rounded-xl" />
      ) : (
        <div key={tool} className="rise">
          {tool === 'pulse' && <V2Pulse kpis={kpis} cells={cells} sentiment={sentiment} flow={flow} />}
          {tool === 'markets' && <V2MarketsTool cells={cells} />}
          {tool === 'sentiment' && <V2SentimentTool sentiment={sentiment} cells={cells} />}
          {tool === 'vol' && <V2VolTool cells={cells} />}
          {tool === 'styles' && <V2StylesTool styles={roster.styles} loading={roster.loading} />}
          {tool === 'flow' && <V2FlowTape rows={flow} title="Live bets" />}
        </div>
      )}
    </div>
  );
}
