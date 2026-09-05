import { describe, it, expect } from 'vitest';
import { KELLY_TABS, hrefForTab, tabFromPath, tabFromSegments, availableTabs, isTabAvailable } from './hub-tabs';

describe('Kelly hub tabs', () => {
  it('reads the tab from the catch-all segments, defaulting to chat', () => {
    expect(tabFromSegments(undefined)).toBe('chat');
    expect(tabFromSegments([])).toBe('chat');
    expect(tabFromSegments(['autopilot'])).toBe('autopilot');
    expect(tabFromSegments(['record'])).toBe('record');
    expect(tabFromSegments(['results'])).toBeNull();
    expect(tabFromSegments(['autopilot', 'more'])).toBeNull();
  });

  it('reads the tab from a pathname, ignoring a trailing slash or a query', () => {
    expect(tabFromPath('/v2/kelly')).toBe('chat');
    expect(tabFromPath('/v2/kelly/')).toBe('chat');
    expect(tabFromPath('/v2/kelly/autopilot')).toBe('autopilot');
    expect(tabFromPath('/v2/kelly/record?x=1')).toBe('record');
    expect(tabFromPath('/v2/copilot')).toBeNull();
    expect(tabFromPath('/v2/kellyx')).toBeNull();
  });

  it('gives every tab an address that reads back to itself', () => {
    for (const t of KELLY_TABS) expect(tabFromPath(hrefForTab(t.id))).toBe(t.id);
    expect(hrefForTab('chat')).toBe('/v2/kelly');
    expect(hrefForTab('autopilot')).toBe('/v2/kelly/autopilot');
  });

  it('hides the optional tabs behind the same flags as their pages', () => {
    const off = { autopilot: false, receipts: false };
    expect(availableTabs(off).map((t) => t.id)).toEqual(['chat']);
    expect(availableTabs({ autopilot: true, receipts: false }).map((t) => t.id)).toEqual(['chat', 'autopilot']);
    expect(isTabAvailable('chat', off)).toBe(true);
    expect(isTabAvailable('record', { autopilot: false, receipts: true })).toBe(true);
  });
});
