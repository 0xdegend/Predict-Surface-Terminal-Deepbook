'use client';

/**
 * KellyTrackRecordShareModal — share Kelly's Track Record as an image card.
 * Same flow as the trader / position / fear & greed share dialogs: paint the card
 * on a canvas, preview it large, and offer Save / Copy / Share on X.
 *
 * X's web intent can't attach an upload, so "Share on X" copies the image to the
 * clipboard and opens the composer with prefilled text — the user pastes it in.
 */
import { useEffect, useRef, useState } from 'react';
import { LuDownload, LuCopy, LuCheck } from 'react-icons/lu';
import { FaXTwitter } from 'react-icons/fa6';
import { Modal } from '@/app/_components/ui/modal';
import { drawTrackRecordCard, loadTrackRecordArt, type TrackRecordShareData } from './kelly-track-record-share-card-canvas';

/** The X post text. Plain language, no em-dashes, tagged @skew_sui. */
function shareText(d: TrackRecordShareData): string {
  const kind = d.tab === 'forecast' ? 'forecast' : 'pick';
  if (d.winRate != null && d.settled > 0) {
    const wr = Math.round(d.winRate * 100);
    return (
      `🦊 Kelly's ${kind} win rate on @skew_sui: ${wr}% over ${d.settled} settled ${kind}${d.settled === 1 ? '' : 's'}.\n\n` +
      `Every call is signed to Walrus the moment it's made, so nothing can be edited after the fact. Verify them all 👇`
    );
  }
  return (
    `🦊 Kelly, our Predict AI agent on @skew_sui, signs every ${kind} to Walrus the moment it's made. ` +
    `A track record you can verify, with nothing edited after the fact. See it 👇`
  );
}

export function KellyTrackRecordShareModal({
  open,
  data,
  onClose,
}: {
  open: boolean;
  data: TrackRecordShareData | null;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<null | 'saved' | 'copied' | 'shared' | 'nocopy'>(null);
  const ready = open && data != null;

  // Repaint whenever the dialog opens or the record changes.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      await loadTrackRecordArt();
      if (cancelled || !canvasRef.current) return;
      setStatus(null);
      drawTrackRecordCard(canvasRef.current, data!);
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, data]);

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
    a.download = `skew-kelly-${data?.tab === 'forecast' ? 'forecasts' : 'picks'}.png`;
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
    if (data) {
      const intent =
        `https://twitter.com/intent/tweet` +
        `?text=${encodeURIComponent(shareText(data))}` +
        `&url=${encodeURIComponent('https://tryskew.xyz/v2/track-record')}`;
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
          ? 'Post pre-filled & tagged @skew_sui — paste the card (Ctrl/⌘+V) to attach it.'
          : status === 'nocopy'
            ? 'Clipboard unavailable — use Save Image instead.'
            : 'Save it, copy it, or post it on X.';

  const statusTone = status === 'nocopy' ? 'text-warn' : status ? 'text-up' : 'text-text-3';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Share Kelly’s record"
      subtitle="A card to post on X"
      maxWidthClass="max-w-2xl"
      variant="glass"
      contentClassName="px-5 pb-5"
    >
      <div className="flex flex-col gap-5">
        <div className="mx-auto w-full">
          <canvas
            ref={canvasRef}
            aria-label="Kelly track record share card preview"
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
