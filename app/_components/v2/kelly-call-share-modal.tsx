'use client';

/**
 * KellyCallShareModal — share a SINGLE Kelly call (a forecast or a pick) as an
 * image card. Same flow as the other share dialogs: paint on a canvas, preview
 * large, and offer Save / Copy / Share on X. The post links to the call's own
 * verifiable page (/v2/track-record/[blobId]), so the receipt is one tap away.
 */
import { useEffect, useRef, useState } from 'react';
import { LuDownload, LuCopy, LuCheck } from 'react-icons/lu';
import { FaXTwitter } from 'react-icons/fa6';
import { Modal } from '@/app/_components/ui/modal';
import { drawCallCard, loadCallArt, type CallShareData } from './kelly-call-share-card-canvas';

/** The X post text. Plain language, no em-dashes, tagged @skew_sui, honest on a loss. */
function shareText(d: CallShareData): string {
  const kind = d.role === 'read' ? 'forecast' : 'pick';
  if (d.outcome === 'won') {
    return (
      `🦊 Kelly called it. ${d.summary} — WON.\n\n` +
      `Signed to Walrus the moment it was made on @skew_sui, so it can't be edited after the fact. Verify 👇`
    );
  }
  if (d.outcome === 'lost') {
    return (
      `🦊 Kelly's ${kind}: ${d.summary} — didn't hit this time.\n\n` +
      `Win or lose, every call is signed to Walrus the moment it's made on @skew_sui. No edits. 👇`
    );
  }
  return (
    `🦊 Kelly's live ${kind}: ${d.summary}.\n\n` +
    `Signed to Walrus the moment it was made on @skew_sui. Track how it plays out 👇`
  );
}

export function KellyCallShareModal({
  open,
  data,
  onClose,
}: {
  open: boolean;
  data: CallShareData | null;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<null | 'saved' | 'copied' | 'shared' | 'nocopy'>(null);
  const ready = open && data != null;

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      await loadCallArt();
      if (cancelled || !canvasRef.current) return;
      setStatus(null);
      drawCallCard(canvasRef.current, data!);
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
    a.download = 'skew-kelly-call.png';
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
        `&url=${encodeURIComponent(`https://tryskew.xyz/v2/track-record/${data.blobId}`)}`;
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
      title="Share this call"
      subtitle="A card to post on X"
      maxWidthClass="max-w-2xl"
      variant="glass"
      contentClassName="px-5 pb-5"
    >
      <div className="flex flex-col gap-5">
        <div className="mx-auto w-full">
          <canvas
            ref={canvasRef}
            aria-label="Kelly call share card preview"
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
