'use client';

import { useEffect, useRef, useState } from 'react';
import { LuDownload, LuCopy, LuCheck } from 'react-icons/lu';
import { FaXTwitter } from 'react-icons/fa6';
import { Modal } from '@/app/_components/ui/modal';
import { signed, price } from '@/lib/format';
import {
  drawShareCard,
  loadShareLogo,
  SHARE_VARIANTS,
  type ShareCardData,
  type ShareVariant,
} from './share-card-canvas';

/**
 * Share-as-image dialog. Renders the position as a promotional card on a canvas
 * (see share-card-canvas.ts), lets the user pick a style, previews it large, and
 * offers download / clipboard / X for the selected one.
 *
 * X's web intent can't attach an upload, so "Share on X" copies the image to the
 * clipboard and opens the composer with prefilled text — the user pastes it in.
 */
export function ShareCardModal({
  open,
  onClose,
  data,
}: {
  open: boolean;
  onClose: () => void;
  data: ShareCardData | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const thumbRefs = useRef<Record<string, HTMLCanvasElement | null>>({});
  const [variant, setVariant] = useState<ShareVariant>('glow');
  const [status, setStatus] = useState<null | 'saved' | 'copied' | 'shared' | 'nocopy'>(null);

  // Repaint the large preview whenever the dialog opens or the style changes.
  useEffect(() => {
    if (!open || !data) return;
    let cancelled = false;
    (async () => {
      await Promise.all([document.fonts.ready, loadShareLogo()]);
      if (cancelled || !canvasRef.current) return;
      setStatus(null);
      drawShareCard(canvasRef.current, data, { variant });
    })();
    return () => {
      cancelled = true;
    };
  }, [open, data, variant]);

  // Paint every style's thumbnail once the dialog opens.
  useEffect(() => {
    if (!open || !data) return;
    let cancelled = false;
    (async () => {
      await Promise.all([document.fonts.ready, loadShareLogo()]);
      if (cancelled) return;
      for (const v of SHARE_VARIANTS) {
        const el = thumbRefs.current[v.id];
        if (el) drawShareCard(el, data, { variant: v.id, scale: 0.5 });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, data]);

  const flash = (s: typeof status) => {
    setStatus(s);
    setTimeout(() => setStatus(null), 2200);
  };

  const toBlob = () =>
    new Promise<Blob | null>((resolve) =>
      canvasRef.current ? canvasRef.current.toBlob(resolve, 'image/png') : resolve(null),
    );

  const fileName = data
    ? `skew-${data.underlying.toLowerCase()}-${data.result}-${variant}.png`
    : 'skew-position.png';

  const save = async () => {
    const blob = await toBlob();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
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
      const bet = data.band
        ? `${data.underlying} in $${price(data.band.lower)}–$${price(data.band.higher)}`
        : `${data.underlying} ${data.up ? '≥' : '≤'} $${price(data.strike)}`;
      const verb =
        data.result === 'won'
          ? `WON ${signed(data.pnlPct * 100, 1)}%`
          : data.result === 'lost'
            ? `closed ${signed(data.pnlPct * 100, 1)}%`
            : `riding ${signed(data.pnlPct * 100, 1)}%`;
      const text =
        `${bet} — ${verb} on DeepBook Predict 📈\n\n` +
        `Trading the live volatility surface on @SuiNetwork 👇`;
      const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&hashtags=Sui,DeepBook`;
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
          ? 'Image copied — paste it into your tweet (Ctrl/⌘+V).'
          : status === 'nocopy'
            ? 'Clipboard unavailable — use Save Image instead.'
            : 'Pick a style, then save or post it.';

  const statusTone =
    status === 'nocopy' ? 'text-warn' : status ? 'text-up' : 'text-text-3';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Share position"
      subtitle="A card to post on X"
      maxWidthClass="max-w-4xl"
      variant="glass"
      contentClassName="px-5 pb-5"
    >
      <div className="flex flex-col gap-5 sm:flex-row">
        {/* preview — the hero of the dialog. Full-width on mobile; only center
            it vertically against the style rail on the sm+ row layout (an
            unconditional self-center mis-sizes the box in the column and lets it
            overlap the cards below, eating their taps). */}
        <div className="w-full sm:flex-1 sm:self-center">
          <canvas
            ref={canvasRef}
            className="pointer-events-none w-full rounded-xl shadow-[0_18px_50px_-20px_rgba(0,0,0,0.8)] ring-1 ring-white/6"
            style={{ aspectRatio: '1200 / 675' }}
          />
        </div>

        {/* right rail — style picker */}
        <div className="flex w-full shrink-0 flex-col gap-2.5 sm:w-57.5">
          <p className="eyebrow">Style</p>
          {SHARE_VARIANTS.map((v) => {
            const selected = v.id === variant;
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => setVariant(v.id)}
                aria-pressed={selected}
                aria-label={`${v.label} style`}
                className={`group relative cursor-pointer touch-manipulation overflow-hidden rounded-lg transition-all ${
                  selected
                    ? 'ring-2 ring-(--accent-line) shadow-[0_0_24px_-8px_var(--accent-glow)]'
                    : 'ring-1 ring-white/6 hover:ring-white/15'
                }`}
              >
                <canvas
                  ref={(el) => {
                    thumbRefs.current[v.id] = el;
                  }}
                  className="pointer-events-none block w-full"
                  style={{ aspectRatio: '1200 / 675' }}
                />
                <span
                  className={`pointer-events-none absolute bottom-1.5 left-2 text-[11px] font-medium drop-shadow ${
                    selected ? 'text-up' : 'text-text-1'
                  }`}
                >
                  {v.label}
                </span>
                {selected && (
                  <span className="pointer-events-none absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-up text-bg-0">
                    <LuCheck size={11} strokeWidth={3} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* footer row — hint + actions, centered */}
      <div className="mt-5 flex flex-col items-center gap-3">
        <p className={`min-h-4 text-center font-sans text-[11px] leading-snug ${statusTone}`}>
          {msg}
        </p>
        <div className="flex w-full flex-wrap items-center justify-center gap-2.5">
          <button
            onClick={save}
            className="ctrl-soft inline-flex items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-[12px] font-medium text-text-1"
          >
            {status === 'saved' ? <LuCheck size={14} /> : <LuDownload size={14} />}
            Save Image
          </button>
          <button
            onClick={copy}
            className="ctrl-soft inline-flex items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-[12px] font-medium text-text-1"
          >
            {status === 'copied' ? <LuCheck size={14} /> : <LuCopy size={14} />}
            Copy
          </button>
          <button
            onClick={shareOnX}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-(--accent-line) bg-up/10 px-5 py-2.5 text-[12px] font-semibold text-up shadow-[0_0_22px_-8px_var(--accent-glow)] hover:bg-up/20"
          >
            <FaXTwitter size={13} />
            Share on X
          </button>
        </div>
      </div>
    </Modal>
  );
}
