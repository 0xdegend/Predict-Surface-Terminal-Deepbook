/**
 * Guided-tour step config for the home (Trade) screen. Two tours share one engine
 * (TourOverlay): an ORIENTATION tour ("what's on screen") that first-time visitors
 * get automatically, and a "HOW TO PLACE A TRADE" tour a new trader can pick from the
 * "?" menu (or the ticket's empty state). Each `target` is a CSS selector for a
 * `data-tour="..."` anchor on the real section — the overlay resolves these at runtime
 * and silently skips any that aren't mounted (e.g. the ticket controls before a market
 * is loaded), so a tour always reflects what's actually on screen.
 */
import { V2_SESSIONS_ENABLED } from '@/config/predict';

export interface TourStep {
  id: string;
  /** Selector for the section to spotlight. */
  target: string;
  /** Full heading (mobile card + used elsewhere); the desktop stepper uses `short`. */
  title: string;
  /** Compact label for the bottom stepper card so all steps fit without scroll. */
  short: string;
  body: string;
}

export type TourId = 'orientation' | 'trade';

export interface TourDef {
  id: TourId;
  /** Menu label. */
  label: string;
  /** One-line menu description. */
  blurb: string;
  /** localStorage key marking this tour as seen (drives first-visit + replay). */
  seenKey: string;
  steps: TourStep[];
}

/* ----------------------------- orientation ------------------------------- */

const ORIENTATION_BASE: TourStep[] = [
  {
    id: 'chip',
    target: '[data-tour="chip"]',
    title: 'Live price',
    short: 'Price',
    body: 'The current price updates here, the moment the market moves.',
  },
  {
    id: 'surface',
    target: '[data-tour="surface"]',
    title: 'The live map',
    short: 'Map',
    body: 'This 3-D shape is a live map of every trade you can make. Left to right is the price, front to back is the deadline, and the height and color show how big a move the market expects. Hover a point to see its odds; click one to set up that trade.',
  },
  {
    id: 'picker',
    target: '[data-tour="picker"]',
    title: 'Pick a market',
    short: 'Markets',
    body: 'Browse the live markets as simple cards or a compact table. Pick one and it loads into your trade ticket, ready to trade.',
  },
  {
    id: 'svi',
    target: '[data-tour="svi"]',
    title: 'The odds curve',
    short: 'Odds',
    body: 'The curve and numbers behind the prices on the map. They refresh live, the moment the market moves.',
  },
  {
    id: 'ticket',
    target: '[data-tour="ticket"]',
    title: 'Your trade ticket',
    short: 'Ticket',
    body: 'Choose your amount and place the trade in a single step. The price comes straight from the live market, so what you see is what you pay.',
  },
  {
    // Reuses the ticket anchor (the instant-trading toggle lives inside the ticket), so
    // this step always shows whenever the ticket does.
    id: 'instant',
    target: '[data-tour="ticket"]',
    title: 'Instant trading',
    short: 'Instant',
    body: 'Turn on instant trading once and your next taps place in about a second, with no popups and no gas getting in the way.',
  },
];

// Instant trading is dark until the .env turns it on (NEXT_PUBLIC_SESSIONS=1, gated by
// V2_SESSIONS_ENABLED). Don't advertise a feature that isn't live: drop its step until
// then. NEXT_PUBLIC_ vars are build-time constants, so this resolves once at load.
const ORIENTATION_STEPS: TourStep[] = ORIENTATION_BASE.filter(
  (s) => s.id !== 'instant' || V2_SESSIONS_ENABLED,
);

/* ------------------------- how to place a trade -------------------------- */

// Action-oriented, in the order a first-timer actually does it. Opens on the two
// ALWAYS-visible sections (the live view + the market list) so the tour is never a lone
// step, then zooms into the ticket detail — which only exists on wide screens (the ticket
// is a bottom sheet on narrow ones) and once a market is loaded. The overlay resolves each
// anchor to the first VISIBLE match and drops the rest, so on a narrow screen this tour
// gracefully shows just Find + Pick, and fills out to Place-it on desktop. "Set up your bet"
// covers the side/level/amount controls in one step (the ticket's own StepBar already walks
// those, and their anchors move between the binary/range layouts).
const TRADE_STEPS: TourStep[] = [
  {
    id: 'trade-find',
    target: '[data-tour="surface"]',
    title: 'Find a market',
    short: 'Find',
    body: 'This is your live view of the markets — a 3-D map, a chart, or a simple list. Look for one that interests you; the odds and prices update in real time.',
  },
  {
    id: 'trade-pick',
    target: '[data-tour="picker"]',
    title: 'Pick a market',
    short: 'Pick',
    body: 'Tap a market here (or a point on the live map) and it loads into your ticket, ready to trade.',
  },
  {
    id: 'trade-setup',
    target: '[data-tour="ticket"]',
    title: 'Set up your bet',
    short: 'Set up',
    body: 'In your ticket, say which way you think BTC goes — UP if it rises, DOWN if it falls (or switch to a range) — set your level, and type how much to bet. Start small while you learn.',
  },
  {
    id: 'trade-quote',
    target: '[data-tour="quote"]',
    title: 'Check the payout',
    short: 'Payout',
    body: 'See what you would win if you are right, and what it costs. The price is live from the market, so what you see is what you pay.',
  },
  {
    id: 'trade-place',
    target: '[data-tour="place"]',
    title: 'Place it',
    short: 'Place',
    body: 'Hit the button, preview the exact cost, and confirm. That is your trade — you can watch it live and close it any time from your portfolio.',
  },
];

/* -------------------------------- registry ------------------------------- */

export const TOURS: Record<TourId, TourDef> = {
  orientation: {
    id: 'orientation',
    label: 'Take a tour',
    blurb: 'A quick look at what everything on the screen does.',
    seenKey: 'skew.tour.v1',
    steps: ORIENTATION_STEPS,
  },
  trade: {
    id: 'trade',
    label: 'How to place a trade',
    blurb: 'Step by step, from picking a market to placing your first bet.',
    seenKey: 'skew.tour.trade.v1',
    steps: TRADE_STEPS,
  },
};

/** The tour first-time visitors get automatically. */
export const DEFAULT_TOUR: TourId = 'orientation';
