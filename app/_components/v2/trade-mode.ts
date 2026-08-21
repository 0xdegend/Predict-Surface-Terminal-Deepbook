/**
 * How the two trade modes are NAMED and DRAWN — one source, because two controls
 * describe them: the Simple ⇄ Advanced toggle in the header and the first-visit
 * experience dialog. They were carrying their own copies of the icons, which is exactly
 * how a pair like this drifts.
 *
 * ICON CHOICE. The old pair was a lightning bolt and settings sliders: the two most
 * generic glyphs in any startup UI, and neither says anything about a trading screen.
 * These are literal instead.
 *
 *   Simple   → arrows up and down. That IS the product: one decision, two directions.
 *   Advanced → a panelled workspace, which is literally what that screen is (surface,
 *              market picker, ticket rail).
 *
 * Both are otherwise unused in the app, so neither picks up a second meaning. Candidates
 * that read well but were already spoken for: `LuChartSpline` (the Odds rail tab),
 * `LuChartCandlestick` (BTC Options), `LuLayers` and `LuActivity` (used throughout).
 */
import { LuArrowUpDown, LuPanelsTopLeft } from 'react-icons/lu';
import type { IconType } from 'react-icons';
import type { TradeView } from '@/lib/store/trade-view-store';

export const TRADE_MODE_ICON: Record<TradeView, IconType> = {
  simple: LuArrowUpDown,
  advanced: LuPanelsTopLeft,
};

/** The mode's name, as it appears on every control that offers the choice. */
export const TRADE_MODE_LABEL: Record<TradeView, string> = {
  simple: 'Simple',
  advanced: 'Advanced',
};
