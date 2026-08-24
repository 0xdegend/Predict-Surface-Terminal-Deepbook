'use client';

/**
 * OptionsShareModal — share an Options-page snapshot (market read / expected range /
 * bold odds) as an image card. Same flow as the other share dialogs: paint the card
 * on a canvas, preview it large, and offer Save / Copy / Share on X.
 *
 * X's web intent can't attach an upload, so "Share on X" copies the image to the
 * clipboard and opens the composer with prefilled text — the user pastes it in.
 */
import { useEffect, useRef, useState } from 'react';
import { LuDownload, LuCopy, LuCheck } from 'react-icons/lu';
import { FaXTwitter } from 'react-icons/fa6';
import { Modal } from '@/app/_components/ui/modal';
import { type OptionsShareCard, optionsShareText } from '@/lib/share/options-share';
import { loadShareArt } from '@/app/_components/v2/share/share-kit';
import { drawOptionsShareCard } from './options-share-cards';

const TITLE: Record<OptionsShareCard['kind'], string> = {
  market_read: 'Share the market read',
  expected_range: 'Share the expected range',
  bold_odds: 'Share these odds',
};
const FILE: Record<OptionsShareCard['kind'], string> = {
  market_read: 'skew-market-read.png',
  expected_range: 'skew-expected-range.png',
  bold_odds: 'skew-odds.png',
};

export function OptionsShareModal({ card, onClose }: { card: OptionsShareCard | null; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<null | 'saved' | 'copied' | 'shared' | 'nocopy'>(null);
  const open = card !== null;

  useEffect(() => {
    if (!open || !card) return;
    let cancelled = false;
    (async () => {
      await loadShareArt();
      if (cancelled || !canvasRef.current) return;
      setStatus(null);
      drawOptionsShareCard(canvasRef.current, card);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, card]);

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
    if (!blob || !card) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = FILE[card.kind];
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
    if (card) {
      const intent =
        `https://twitter.com/intent/tweet` +
        `?text=${encodeURIComponent(optionsShareText(card))}` +
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
      title={card ? TITLE[card.kind] : 'Share'}
      subtitle="A card to post on X"
      maxWidthClass="max-w-2xl"
      variant="glass"
      contentClassName="px-5 pb-5"
    >
      <div className="flex flex-col gap-5">
        <div className="mx-auto w-full">
          <canvas
            ref={canvasRef}
            aria-label="Options share card preview"
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
