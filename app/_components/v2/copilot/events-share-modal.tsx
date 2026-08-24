'use client';

/**
 * EventsShareModal — share today's market-moving calendar as an image card. Same
 * flow as the other share dialogs: paint the card on a canvas, preview it, and
 * offer Save / Copy / Share on X. X's web intent can't attach an upload, so
 * "Share on X" copies the image + opens the composer with prefilled text.
 */
import { useEffect, useRef, useState } from 'react';
import { LuDownload, LuCopy, LuCheck } from 'react-icons/lu';
import { FaXTwitter } from 'react-icons/fa6';
import { Modal } from '@/app/_components/ui/modal';
import { loadShareArt } from '@/app/_components/v2/share/share-kit';
import { utcTime } from '@/lib/insights/events';
import { drawEventsCard } from './events-share-card-canvas';

type Event = { title: string; at: number | null; when: string };

/** The X post text. Plain language, no em-dashes, tagged @skew_sui. Uses the exact
 *  UTC time when the event has one, else the relative phrase. */
function shareText(events: Event[]): string {
  const list = events
    .slice(0, 4)
    .map((e) => `• ${e.title} (${e.at != null ? utcTime(e.at) : e.when})`)
    .join('\n');
  return (
    `🗓️ Today's market-movers on my radar:\n\n` +
    `${list}\n\n` +
    `These tend to move BTC. Ask Kelly what's happening and set up a bet on @skew_sui 👇`
  );
}

export function EventsShareModal({
  open,
  events,
  headline,
  onClose,
}: {
  open: boolean;
  events: Event[] | null;
  headline?: string | null;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<null | 'saved' | 'copied' | 'shared' | 'nocopy'>(null);
  const ready = open && !!events && events.length > 0;

  // Repaint whenever the dialog opens or the events change.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      await loadShareArt();
      if (cancelled || !canvasRef.current) return;
      setStatus(null);
      drawEventsCard(canvasRef.current, { events: events!, headline: headline ?? null });
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, events, headline]);

  const flash = (s: typeof status) => {
    setStatus(s);
    setTimeout(() => setStatus(null), 2200);
  };

  const toBlob = () =>
    new Promise<Blob | null>((resolve) =>
      canvasRef.current ? canvasRef.current.toBlob(resolve, 'image/png') : resolve(null),
    );

  const save = async () => {
    const blob = await toBlob();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'skew-today-events.png';
    a.click();
    URL.revokeObjectURL(url);
    flash('saved');
  };

  const copyImage = async (): Promise<boolean> => {
    try {
      const blob = await toBlob();
      if (!blob || !navigator.clipboard || typeof ClipboardItem === 'undefined') return false;
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    } catch {
      return false;
    }
  };

  const copy = async () => {
    flash((await copyImage()) ? 'copied' : 'nocopy');
  };

  const shareOnX = async () => {
    const ok = await copyImage();
    if (events && events.length) {
      const intent =
        `https://twitter.com/intent/tweet` +
        `?text=${encodeURIComponent(shareText(events))}` +
        `&url=${encodeURIComponent('https://tryskew.xyz')}`;
      window.open(intent, '_blank', 'noopener,noreferrer');
    }
    flash(ok ? 'shared' : 'nocopy');
  };

  const msg =
    status === 'saved'
      ? 'Image saved.'
      : status === 'copied'
        ? 'Image copied to clipboard.'
        : status === 'shared'
          ? 'Post is pre-filled and tagged @skew_sui. Paste the card (Ctrl/⌘+V) to attach it.'
          : status === 'nocopy'
            ? 'Your browser won’t let us copy it. Use Save Image instead.'
            : 'Save it, copy it, or post it on X.';

  const statusTone = status === 'nocopy' ? 'text-warn' : status ? 'text-up' : 'text-text-3';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Share today's events"
      subtitle="A card to post on X"
      maxWidthClass="max-w-2xl"
      variant="glass"
      contentClassName="px-5 pb-5"
    >
      <div className="flex flex-col gap-5">
        <div className="mx-auto w-full">
          <canvas
            ref={canvasRef}
            aria-label="Today's events share card preview"
            className="pointer-events-none w-full rounded-xl shadow-[0_18px_50px_-20px_rgba(0,0,0,0.8)] ring-1 ring-white/6"
            style={{ aspectRatio: '1200 / 675' }}
          />
        </div>

        <div className="flex flex-col items-center gap-3">
          <p className={`min-h-4 text-center font-sans text-[11px] leading-snug ${statusTone}`}>{msg}</p>
          <div className="grid w-full grid-cols-1 gap-2.5 sm:flex sm:flex-wrap sm:items-center sm:justify-center">
            <button
              onClick={save}
              className="ctrl-soft inline-flex w-full items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-[12px] font-medium text-text-1 sm:w-auto"
            >
              {status === 'saved' ? <LuCheck size={14} /> : <LuDownload size={14} />}
              Save Image
            </button>
            <button
              onClick={copy}
              className="ctrl-soft inline-flex w-full items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-[12px] font-medium text-text-1 sm:w-auto"
            >
              {status === 'copied' ? <LuCheck size={14} /> : <LuCopy size={14} />}
              Copy
            </button>
            <button
              onClick={shareOnX}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-(--accent-line) bg-up/10 px-5 py-2.5 text-[12px] font-semibold text-up shadow-[0_0_22px_-8px_var(--accent-glow)] hover:bg-up/20 sm:w-auto"
            >
              <FaXTwitter size={13} />
              Share on X
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
