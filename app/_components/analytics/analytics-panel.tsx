'use client';

/**
 * AnalyticsPanel — the Skew Analytics screen. A live read of the market: the
 * order-flow tape + UP/DOWN sentiment (Phase 1). The market heatmap, IV term
 * structure, and trader-style breakdown land here in later phases. Server-data
 * only, so the whole page renders for any visitor (no wallet).
 */
import { LuChartNoAxesCombined } from 'react-icons/lu';
import { predictConfig } from '@/config/predict';
import { FlowTape } from './flow-tape';

export function AnalyticsPanel() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-5">
      {/* Header */}
      <div className="mb-5">
        <h1 className="flex items-center gap-2 text-[20px] font-semibold tracking-tight text-text-1">
          <LuChartNoAxesCombined size={18} className="text-[var(--accent)]" />
          Analytics
        </h1>
        <p className="mt-1 text-[12px] text-text-3">
          The market in motion — live order flow and crowd sentiment across DeepBook Predict ·{' '}
          {predictConfig.network}
        </p>
      </div>

      <FlowTape />
    </div>
  );
}
