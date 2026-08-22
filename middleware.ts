/**
 * middleware.ts — where a phone lands.
 *
 * A trader opening Skew on a phone gets SIMPLE MODE by default: the advanced terminal is
 * a 3-D volatility surface, a market table and a full options ticket, which is not what a
 * first tap on a small screen should open. It is a default, not a lock — the Simple ⇄
 * Advanced toggle (header on desktop, More sheet on a phone) writes `advanced` to the
 * cookie this reads, and from then on that phone lands wherever it chose.
 *
 * WHY MIDDLEWARE and not the page: /v2 has a `loading.tsx`, so Next flushes the shell and
 * a 200 before the page component finishes. A redirect from inside the page is therefore
 * applied by the client router AFTER the terminal has already painted — the exact flash
 * the rule exists to prevent. Middleware runs before any of that and answers with a real
 * 307, so the phone renders one screen: the right one.
 *
 * Desktop is untouched by construction (no mobile device type, no redirect), which is
 * what was asked for. See [[simple-mode]].
 */
import { NextResponse, userAgent, type NextRequest } from 'next/server';
import { TRADE_VIEW_COOKIE, isDocumentRequest, shouldLandOnSimple } from '@/lib/store/trade-view';
import { V2_SIMPLE_ENABLED } from '@/config/predict';

export function middleware(req: NextRequest) {
  const landing = shouldLandOnSimple({
    simpleEnabled: V2_SIMPLE_ENABLED,
    deviceType: userAgent(req).device.type,
    cookieView: req.cookies.get(TRADE_VIEW_COOKIE)?.value,
    // Only a real page load is a landing. See `isDocumentRequest` for why this reads
    // Sec-Fetch-Dest rather than the RSC header (Next strips its own router headers
    // before middleware), and `shouldLandOnSimple` for why the distinction matters.
    documentRequest: isDocumentRequest({
      secFetchDest: req.headers.get('sec-fetch-dest'),
      accept: req.headers.get('accept'),
    }),
  });
  if (!landing) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = '/v2/simple';
  return NextResponse.redirect(url);
}

// `/` server-redirects to `/v2`, so matching both saves a phone one hop.
export const config = { matcher: ['/', '/v2'] };
