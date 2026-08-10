/**
 * Guided-tour step config for the home (Trade) screen. Ordered top-to-bottom so
 * the spotlight walks the page the way a trader's eye would. Each `target` is a
 * CSS selector for a `data-tour="..."` anchor placed on the real section — the
 * overlay resolves these at runtime and silently skips any that aren't mounted
 * (e.g. the trade ticket only renders once there are tradeable markets).
 */
import { V2_SESSIONS_ENABLED } from '@/config/predict';

export interface TourStep {
  id: string;
  /** Selector for the section to spotlight. */
  target: string;
  /** Full heading (used elsewhere); the stepper uses `short`. */
  title: string;
  /** Compact label for the bottom stepper card so all steps fit without scroll. */
  short: string;
  body: string;
}

const BASE_STEPS: TourStep[] = [
  {
    id: "chip",
    target: '[data-tour="chip"]',
    title: "Live price",
    short: "Price",
    body: "The current price updates here, the moment the market moves.",
  },
  {
    id: "surface",
    target: '[data-tour="surface"]',
    title: "The live map",
    short: "Map",
    body: "This 3-D shape is a live map of every trade you can make. Left to right is the price, front to back is the deadline, and the height and color show how big a move the market expects. Hover a point to see its odds; click one to set up that trade.",
  },
  {
    id: "picker",
    target: '[data-tour="picker"]',
    title: "Pick a market",
    short: "Markets",
    body: "Browse the live markets as simple cards or a compact table. Pick one and it loads into your trade ticket, ready to trade.",
  },
  {
    id: "svi",
    target: '[data-tour="svi"]',
    title: "The odds curve",
    short: "Odds",
    body: "The curve and numbers behind the prices on the map. They refresh live, the moment the market moves.",
  },
  {
    id: "ticket",
    target: '[data-tour="ticket"]',
    title: "Your trade ticket",
    short: "Ticket",
    body: "Choose your amount and place the trade in a single step. The price comes straight from the live market, so what you see is what you pay.",
  },
  {
    // Reuses the ticket anchor (the instant-trading toggle lives inside the ticket), so
    // this step always shows whenever the ticket does.
    id: "instant",
    target: '[data-tour="ticket"]',
    title: "Instant trading",
    short: "Instant",
    body: "Turn on instant trading once and your next taps place in about a second, with no popups and no gas getting in the way.",
  },
];

// Instant trading is dark until the .env turns it on (NEXT_PUBLIC_SESSIONS=1, gated by
// V2_SESSIONS_ENABLED). Don't advertise a feature that isn't live: drop its step until
// then. NEXT_PUBLIC_ vars are build-time constants, so this resolves once at load.
export const TOUR_STEPS: TourStep[] = BASE_STEPS.filter(
  (s) => s.id !== "instant" || V2_SESSIONS_ENABLED,
);
