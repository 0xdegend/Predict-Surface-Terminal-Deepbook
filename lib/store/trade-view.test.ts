import { describe, it, expect } from 'vitest';
import { shouldLandOnSimple, isDocumentRequest, tradeHref, isTradeRoute } from './trade-view';

const ask = (o: Partial<Parameters<typeof shouldLandOnSimple>[0]> = {}) =>
  shouldLandOnSimple({
    simpleEnabled: true,
    deviceType: 'mobile',
    cookieView: undefined,
    documentRequest: true,
    ...o,
  });

describe('shouldLandOnSimple', () => {
  it('sends a phone with no stated preference to simple mode', () => {
    expect(ask()).toBe(true);
  });

  it('keeps sending a phone that last chose simple', () => {
    expect(ask({ cookieView: 'simple' })).toBe(true);
  });

  it('leaves a phone that chose Advanced alone — the whole point of the cookie', () => {
    expect(ask({ cookieView: 'advanced' })).toBe(false);
  });

  it('never touches desktop', () => {
    expect(ask({ deviceType: undefined })).toBe(false);
  });

  it('never touches tablets', () => {
    expect(ask({ deviceType: 'tablet' })).toBe(false);
  });

  it('does nothing while simple mode is flagged off, so the kill switch still kills it', () => {
    expect(ask({ simpleEnabled: false })).toBe(false);
    expect(ask({ simpleEnabled: false, cookieView: 'simple' })).toBe(false);
  });

  it('leaves in-app navigation and prefetches alone — only a real landing is redirected', () => {
    // Tapping Advanced on a phone pushes to /v2 with the cookie already written, but the
    // toggle also PREFETCHES /v2 while the cookie still says simple. Redirecting that
    // prefetch would cache a redirect against the href and undo the tap.
    expect(ask({ documentRequest: false })).toBe(false);
    expect(ask({ documentRequest: false, cookieView: 'simple' })).toBe(false);
  });

  it('ignores a junk cookie value rather than trusting it as "advanced"', () => {
    expect(ask({ cookieView: 'ADVANCED' })).toBe(true);
    expect(ask({ cookieView: '' })).toBe(true);
  });
});

describe('isDocumentRequest', () => {
  // Next strips RSC / Next-Router-* before middleware sees them (measured), so the
  // browser's own fetch metadata is what this has to work from.
  it('treats a browser navigation as a landing', () => {
    expect(isDocumentRequest({ secFetchDest: 'document', accept: 'text/html,*/*' })).toBe(true);
  });

  it('treats an in-app fetch (RSC nav or prefetch) as not a landing', () => {
    expect(isDocumentRequest({ secFetchDest: 'empty', accept: '*/*' })).toBe(false);
    expect(isDocumentRequest({ secFetchDest: 'empty', accept: 'text/x-component' })).toBe(false);
  });

  it('falls back to Accept for browsers with no Sec-Fetch-Dest (Safari < 16.4)', () => {
    expect(isDocumentRequest({ secFetchDest: null, accept: 'text/html,application/xhtml+xml' })).toBe(true);
    expect(isDocumentRequest({ secFetchDest: null, accept: 'text/x-component' })).toBe(false);
    expect(isDocumentRequest({ secFetchDest: undefined, accept: undefined })).toBe(false);
  });

  it('never mistakes an image or script fetch for a landing', () => {
    expect(isDocumentRequest({ secFetchDest: 'image', accept: 'image/*' })).toBe(false);
    expect(isDocumentRequest({ secFetchDest: 'script', accept: '*/*' })).toBe(false);
  });
});

describe('tradeHref / isTradeRoute', () => {
  it('routes by remembered view, honouring the flag', () => {
    expect(tradeHref('simple', true)).toBe('/v2/simple');
    expect(tradeHref('advanced', true)).toBe('/v2');
    expect(tradeHref('simple', false)).toBe('/v2');
  });

  it('recognises both trade screens and nothing else', () => {
    expect(isTradeRoute('/v2')).toBe(true);
    expect(isTradeRoute('/v2/simple')).toBe(true);
    expect(isTradeRoute('/v2/portfolio')).toBe(false);
  });
});
