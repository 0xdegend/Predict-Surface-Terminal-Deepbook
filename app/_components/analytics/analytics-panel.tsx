'use client';

/**
 * AnalyticsPanel — the Skew Analytics screen. A glass tool-switcher (rail on
 * desktop, pills on mobile) drives a single content area, so each tool reads as
 * its own instrument: the market map, crowd sentiment, and the live flow tape.
 * The IV term structure + trader-style tools land here as more tools in later
 * phases. Server-data only — the whole page renders for any visitor (no wallet).
 */
import { useState } from 'react';
import { LuChartNoAxesCombined } from 'react-icons/lu';
import { predictConfig } from '@/config/predict';
import { AnalyticsRail, AnalyticsTabs, type AnalyticsTool } from './analytics-nav';
import { MarketHeatmap } from './market-heatmap';
import { SentimentTab } from './sentiment-tab';
import { VolTab } from './vol-tab';
import { StylesTab } from './styles-tab';
import { FlowTape } from './flow-tape';

export function AnalyticsPanel() {
  const [tool, setTool] = useState<AnalyticsTool>('markets');

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-5">
      {/* Header */}
      <div className="mb-5">
        <h1 className="flex items-center gap-2 text-[20px] font-semibold tracking-tight text-text-1">
          <LuChartNoAxesCombined size={18} className="text-accent" />
          Analytics
        </h1>
        <p className="mt-1 text-[12px] text-text-3">
          See what everyone’s betting on right now — live bets, the crowd’s mood, and how prices are
          moving · {predictConfig.network}
        </p>
      </div>

      <div className="flex gap-5">
        <AnalyticsRail active={tool} onSelect={setTool} />

        <div className="min-w-0 flex-1">
          <AnalyticsTabs active={tool} onSelect={setTool} />
          {tool === 'markets' && <MarketHeatmap />}
          {tool === 'sentiment' && <SentimentTab />}
          {tool === 'vol' && <VolTab />}
          {tool === 'styles' && <StylesTab />}
          {tool === 'flow' && <FlowTape />}
        </div>
      </div>
    </div>
  );
}
