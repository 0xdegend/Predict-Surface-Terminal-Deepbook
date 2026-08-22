/**
 * lib/store/trade-view — the trade-view facts that BOTH the client and the server need.
 *
 * The remembered view itself lives in localStorage (see the zustand store next door),
 * which the server cannot read. The mobile landing rule has to run on the server, before
 * any JS, or a phone would render the whole advanced terminal and then jump — so the
 * choice is mirrored into a cookie and the rule is a pure function of it.
 *
 * Kept free of 'use client' so a Server Component can call these directly; the store
 * re-exports them, so client code carries on importing from there.
 */
export type TradeView = 'simple' | 'advanced';

/** Mirrors the persisted view for the server's eyes only. Value is a bare TradeView. */
export const TRADE_VIEW_COOKIE = 'skew.tradeView.v';

/** The Trade-tab href for a remembered view, honoring the feature flag. */
export function tradeHref(view: TradeView, simpleEnabled: boolean): string {
  return simpleEnabled && view === 'simple' ? '/v2/simple' : '/v2';
}

/** True when a pathname is either trade screen (advanced `/v2` or `/v2/simple`). */
export function isTradeRoute(pathname: string): boolean {
  return pathname === '/v2' || pathname.startsWith('/v2/simple');
}

/**
 * Is this request someone ARRIVING at a page, rather than the app fetching a route for
 * itself?
 *
 * Next STRIPS its own router headers (`RSC`, `Next-Router-Prefetch`,
 * `Next-Router-State-Tree`) before middleware runs — measured against the dev server, all
 * three arrive as null — so the usual "is this an RSC request" check is not available
 * there. What does survive is the browser's own `Sec-Fetch-Dest`: `document` for a real
 * navigation, `empty` for a fetch. Browsers older than that header (Safari before 16.4)
 * fall back to `Accept`, which is `text/html…` for a navigation and not for an RSC fetch.
 */
export function isDocumentRequest({
  secFetchDest,
  accept,
}: {
  secFetchDest: string | null | undefined;
  accept: string | null | undefined;
}): boolean {
  if (secFetchDest) return secFetchDest === 'document';
  return (accept ?? '').includes('text/html');
}

/**
 * Should this request for `/v2` be sent to simple mode instead?
 *
 * Phones land on the calm screen by default: the advanced terminal is a 3-D surface, a
 * market table and a full options ticket, which is not what a first tap on a phone should
 * open. It is a DEFAULT, not a lock — the moment a trader picks Advanced (header toggle or
 * the mobile More sheet) the store writes `advanced` to the cookie and this stops firing,
 * on that phone, for good.
 *
 * Desktop is untouched by construction: no device type, no redirect. Tablets are left
 * alone too — they get the wide layout, and iPad Safari reports a desktop UA anyway, so
 * treating them as phones would be half-right at best.
 */
export function shouldLandOnSimple({
  simpleEnabled,
  deviceType,
  cookieView,
  documentRequest,
}: {
  simpleEnabled: boolean;
  /** `userAgent(request).device.type` — 'mobile', 'tablet', or undefined for desktop. */
  deviceType: string | undefined;
  /** The mirrored cookie, if this browser has ever made a choice. */
  cookieView: string | undefined;
  /**
   * Is this someone ARRIVING (a page load), rather than the app fetching a route for
   * itself? In-app navigations and prefetches carry the `RSC` header, and they are always
   * a deliberate act — the Trade tab already routes by the remembered view, and the only
   * other way to /v2 on a phone is tapping Advanced. Redirecting those would both undo
   * the tap and poison the prefetch cache with a redirect, so this rule only ever applies
   * to a real landing.
   */
  documentRequest: boolean;
}): boolean {
  if (!simpleEnabled) return false;
  if (!documentRequest) return false;
  if (deviceType !== 'mobile') return false;
  return cookieView !== 'advanced';
}
