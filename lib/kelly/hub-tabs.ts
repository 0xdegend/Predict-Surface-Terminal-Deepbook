/**
 * lib/kelly/hub-tabs.ts — the tabs of Kelly's hub (/v2/kelly), as data.
 *
 * One page for everything Kelly does: the chat, Autopilot, and her signed track record.
 * Each tab has its own address so a link opens straight to it, and switching tabs is a
 * history push that never remounts the page. Pure, so the route, the client hub and the
 * tests all read the same table.
 */

export type KellyTab = 'chat' | 'autopilot' | 'record';

export const KELLY_HUB_BASE = '/v2/kelly';

export interface KellyTabDef {
  id: KellyTab;
  /** The tab label. Short: it sits in a segmented control. */
  label: string;
  /** Browser-tab / link-preview title. */
  title: string;
  /** One plain sentence for link previews and the tab's tooltip. */
  description: string;
  /** The path segment under the hub; '' is the default tab. */
  segment: '' | 'autopilot' | 'record';
}

export const KELLY_TABS: readonly KellyTabDef[] = [
  {
    id: 'chat',
    label: 'Chat',
    title: 'Kelly',
    description: 'Ask about any market in plain words and get a ready-to-place trade.',
    segment: '',
  },
  {
    id: 'autopilot',
    label: 'Autopilot',
    title: 'Kelly · Autopilot',
    description: 'Let Kelly place her best-value bets for you, within the rules and budget you set.',
    segment: 'autopilot',
  },
  {
    id: 'record',
    label: 'Record',
    title: "Kelly's Record",
    description:
      'Every prediction Kelly makes on BTC is signed and written to Walrus the moment it lands, so it cannot be edited after the fact.',
    segment: 'record',
  },
];

export const tabDef = (id: KellyTab): KellyTabDef => KELLY_TABS.find((t) => t.id === id)!;

export const hrefForTab = (id: KellyTab): string => {
  const seg = tabDef(id).segment;
  return seg ? `${KELLY_HUB_BASE}/${seg}` : KELLY_HUB_BASE;
};

/** The tab for an optional catch-all `[[...tab]]` param, or null for an unknown path. */
export function tabFromSegments(segments: readonly string[] | undefined): KellyTab | null {
  const seg = (segments ?? []).filter(Boolean);
  if (seg.length === 0) return 'chat';
  if (seg.length > 1) return null;
  return KELLY_TABS.find((t) => t.segment === seg[0])?.id ?? null;
}

/** The tab for a full pathname, or null when the path is not under the hub. */
export function tabFromPath(pathname: string): KellyTab | null {
  const clean = pathname.split(/[?#]/)[0] ?? '';
  if (clean !== KELLY_HUB_BASE && !clean.startsWith(`${KELLY_HUB_BASE}/`)) return null;
  return tabFromSegments(clean.slice(KELLY_HUB_BASE.length).split('/'));
}

/* ------------------------------ availability ------------------------------ */

/** The two optional tabs ship behind the same flags as their standalone pages, so the
 *  hub never shows a door the rest of the app keeps shut. */
const AUTOPILOT_ON = process.env.NEXT_PUBLIC_AUTOPILOT === '1';
const RECEIPTS_ON = process.env.NEXT_PUBLIC_KELLY_RECEIPTS === '1';

export function isTabAvailable(id: KellyTab, flags = { autopilot: AUTOPILOT_ON, receipts: RECEIPTS_ON }): boolean {
  if (id === 'autopilot') return flags.autopilot;
  if (id === 'record') return flags.receipts;
  return true;
}

export const availableTabs = (flags?: { autopilot: boolean; receipts: boolean }): KellyTabDef[] =>
  KELLY_TABS.filter((t) => isTabAvailable(t.id, flags));
