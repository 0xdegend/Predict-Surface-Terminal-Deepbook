'use client';

/**
 * KellyHub — one page for everything Kelly does.
 *
 * Three tabs under the chrome: Chat (the surface and the conversation), Autopilot (Kelly
 * trading your rules), and Record (her signed calls). They used to be three pages under
 * the "Kelly" menu, which meant three homes for one character and two different Kelly
 * chats. Here the character has one home and the tabs are the rooms.
 *
 * Switching tabs is a history push, not a navigation. The page never remounts, so:
 *   - the chat thread survives a look at Autopilot and back;
 *   - a live Autopilot run keeps trading while you chat, and keeps trading anywhere else
 *     in /v2 too, because its engine hangs off the layout (see autopilot/engine-provider);
 *   - each tab still has its own address for links, and the back button walks tabs.
 * A pane mounts the first time its tab is opened and stays mounted after that. Landing
 * on /v2/kelly/autopilot mounts only Autopilot; the chat comes in when you open it.
 *
 * The chat pane is hidden differently from the other two. `display: none` collapses the
 * 3-D surface's canvas to 0×0, the renderer and camera are sized to nothing, and when the
 * tab comes back the surface paints a white block with its labels bunched in a corner.
 * So the chat is parked instead: a fixed box the size of the visible one, invisible and
 * inert, so the canvas keeps its size and simply carries on. Autopilot and Record hold no
 * WebGL and can use `hidden`.
 *
 * The bar under the chrome also carries a small live read of a running Autopilot, so a
 * run is never out of sight while you are on another tab.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import dynamic from 'next/dynamic';
import type { IconType } from 'react-icons';
import { LuMessageSquare, LuZap, LuBadgeCheck } from 'react-icons/lu';
import { V2CopilotScreen } from '@/app/_components/v2/copilot/copilot-screen';
import { AutopilotSkeleton } from '@/app/_components/v2/autopilot/skeleton';
import { RunPill } from '@/app/_components/v2/autopilot/run-pill';
import { MASCOT_SRC } from '@/lib/mascot';
import { availableTabs, hrefForTab, tabFromPath, type KellyTab } from '@/lib/kelly/hub-tabs';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

// Code-split the two heavier panes so the chat tab's first paint does not pay for them.
const AutopilotPanel = dynamic(
  () => import('@/app/_components/v2/autopilot/autopilot-panel').then((m) => m.AutopilotPanel),
  { loading: () => <AutopilotSkeleton /> },
);
const KellyTrackRecordPanel = dynamic(() =>
  import('@/app/_components/v2/kelly-track-record-panel').then((m) => m.KellyTrackRecordPanel),
);

const TAB_ICON: Record<KellyTab, IconType> = {
  chat: LuMessageSquare,
  autopilot: LuZap,
  record: LuBadgeCheck,
};

/** Tab bar height. The chat screen subtracts it from its viewport lock (see
 *  copilot-screen's `--kelly-tabs`), and the extra pixel is the bar's bottom border, so
 *  the locked chat and the bar add up to exactly one viewport with nothing to scroll. */
const TAB_BAR_HEIGHT = 'calc(2.75rem + 1px)';

export function KellyHub({
  initialTab,
  markets,
  pricerSeeds,
  serverNow,
}: {
  initialTab: KellyTab;
  markets: V2Market[];
  pricerSeeds: Record<string, LivePricer>;
  serverNow: number;
}) {
  const tabs = availableTabs();
  const [tab, setTab] = useState<KellyTab>(initialTab);
  /** Every tab opened so far. A pane, once mounted, stays mounted behind the others. */
  const [opened, setOpened] = useState<ReadonlySet<KellyTab>>(() => new Set([initialTab]));

  const show = useCallback((next: KellyTab) => {
    setTab(next);
    setOpened((s) => (s.has(next) ? s : new Set([...s, next])));
    // Autopilot and Record scroll the document; the chat is locked to the viewport.
    // Coming back to the chat from a scrolled page would leave it pushed off the top.
    window.scrollTo({ top: 0 });
  }, []);

  /** A tab click: show it and give it its address, without navigating. */
  const select = useCallback(
    (next: KellyTab) => {
      if (window.location.pathname !== hrefForTab(next)) window.history.pushState(null, '', hrefForTab(next));
      show(next);
    },
    [show],
  );

  // Back/forward walks the addresses the clicks pushed; follow them.
  useEffect(() => {
    const onPop = () => {
      const fromPath = tabFromPath(window.location.pathname);
      if (fromPath) show(fromPath);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [show]);

  const style = { '--kelly-tabs': TAB_BAR_HEIGHT } as CSSProperties;

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={style}>
      <HubBar tabs={tabs.map((t) => t.id)} active={tab} onSelect={select} serverNow={serverNow} />

      {opened.has('chat') && (
        <section
          role="tabpanel"
          id="kelly-pane-chat"
          aria-labelledby="kelly-tab-chat"
          inert={tab !== 'chat'}
          aria-hidden={tab !== 'chat'}
          className={
            tab === 'chat'
              ? 'flex min-h-0 flex-1 flex-col'
              : // Parked, not collapsed: same height as when on show, so the surface's canvas
                // never sees a zero size (see the note at the top of this file).
                'pointer-events-none invisible fixed inset-x-0 bottom-0 top-[calc(4rem+var(--kelly-tabs,0rem))] flex min-h-0 flex-col'
          }
        >
          <V2CopilotScreen markets={markets} pricerSeeds={pricerSeeds} serverNow={serverNow} active={tab === 'chat'} />
        </section>
      )}

      {opened.has('autopilot') && (
        <section role="tabpanel" id="kelly-pane-autopilot" aria-labelledby="kelly-tab-autopilot" hidden={tab !== 'autopilot'} className="flex-1">
          <AutopilotPanel markets={markets} pricerSeeds={pricerSeeds} />
        </section>
      )}

      {opened.has('record') && (
        <section role="tabpanel" id="kelly-pane-record" aria-labelledby="kelly-tab-record" hidden={tab !== 'record'} className="flex-1">
          <KellyTrackRecordPanel />
        </section>
      )}
    </div>
  );
}

/* --------------------------------- the bar -------------------------------- */

function HubBar({
  tabs,
  active,
  onSelect,
  serverNow,
}: {
  tabs: KellyTab[];
  active: KellyTab;
  onSelect: (t: KellyTab) => void;
  serverNow: number;
}) {
  const refs = useRef<Partial<Record<KellyTab, HTMLAnchorElement | null>>>({});

  // Left/right arrows walk the tabs, Home/End jump, as a tablist is expected to.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.indexOf(active);
    let next: KellyTab | null = null;
    if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === 'Home') next = tabs[0];
    else if (e.key === 'End') next = tabs[tabs.length - 1];
    if (!next) return;
    e.preventDefault();
    onSelect(next);
    refs.current[next]?.focus();
  };

  return (
    <div className="sticky top-16 z-30 shrink-0 border-b border-line bg-bg-0/85 backdrop-blur-md">
      <div className="flex h-11 items-center gap-3 px-3 sm:px-5">
        {/* Whose place this is. Small on purpose: the rooms carry their own headers. */}
        <div className="flex items-center gap-2">
          <span className="relative grid h-[22px] w-[22px] flex-none place-items-center overflow-hidden rounded-full ring-1 ring-(--accent-line)">
            <Image src={MASCOT_SRC.confident} alt="" width={22} height={22} className="h-full w-full object-cover" />
          </span>
          <span className="text-[13px] font-semibold tracking-tight text-text-1">Kelly</span>
        </div>
        <span aria-hidden className="h-4 w-px bg-white/10" />

        <div role="tablist" aria-label="Kelly" onKeyDown={onKeyDown} className="glass-inset inline-flex gap-0.5 rounded-lg p-0.5">
          {tabs.map((t) => (
            <HubTab
              key={t}
              id={t}
              active={t === active}
              onSelect={onSelect}
              anchorRef={(el) => {
                refs.current[t] = el;
              }}
            />
          ))}
        </div>

        <div className="ml-auto flex min-w-0 items-center">
          <RunPill onOpen={() => onSelect('autopilot')} disabled={active === 'autopilot'} serverNow={serverNow} />
        </div>
      </div>
    </div>
  );
}

const TAB_LABEL: Record<KellyTab, string> = { chat: 'Chat', autopilot: 'Autopilot', record: 'Record' };

function HubTab({
  id,
  active,
  onSelect,
  anchorRef,
}: {
  id: KellyTab;
  active: boolean;
  onSelect: (t: KellyTab) => void;
  anchorRef: (el: HTMLAnchorElement | null) => void;
}) {
  const Icon = TAB_ICON[id];
  return (
    <Link
      ref={anchorRef}
      href={hrefForTab(id)}
      role="tab"
      id={`kelly-tab-${id}`}
      aria-selected={active}
      aria-controls={`kelly-pane-${id}`}
      tabIndex={active ? 0 : -1}
      prefetch={false}
      onClick={(e) => {
        // Plain click: switch in place. Modified clicks (new tab, etc.) keep the real link.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        onSelect(id);
      }}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-all duration-200 ${
        active ? 'bg-(--accent-soft) text-text-1' : 'text-text-3 hover:text-text-2'
      }`}
    >
      <Icon size={12} className={active ? 'text-accent' : undefined} />
      {TAB_LABEL[id]}
    </Link>
  );
}
