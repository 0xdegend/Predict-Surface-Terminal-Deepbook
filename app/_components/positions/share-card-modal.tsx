'use client';

import { useEffect, useRef, useState } from 'react';
import { LuDownload, LuCopy, LuCheck, LuImagePlay } from 'react-icons/lu';
import { FaXTwitter } from 'react-icons/fa6';
import { Modal } from '@/app/_components/ui/modal';
import { signed, price } from '@/lib/format';
import {
  drawShareCard,
  loadShareLogo,
  loadBrandMarks,
  shareVariants,
  type ShareCardData,
  type ShareVariant,
} from './share-card-canvas';
import { renderCardGif } from './animated-share-card';

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
  const [status, setStatus] = useState<null | 'saved' | 'copied' | 'shared' | 'nocopy' | 'gif' | 'giferr'>(null);
  // GIF export progress: null = idle, 0..1 = generating.
  const [gifPct, setGifPct] = useState<number | null>(null);

  // The styles offered depend on the result (winners also get "Celebrate").
  const variants = shareVariants(data?.result ?? 'live');

  // On each open, lead with the festive card for a win, else the default glow.
  // Adjusting state during render (guarded by the open transition) is the React-
  // recommended way to reset on a prop change — no setState-in-effect churn.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setVariant(data?.result === 'won' ? 'celebrate' : 'glow');
  }

  // Repaint the large preview whenever the dialog opens or the style changes.
  useEffect(() => {
    if (!open || !data) return;
    let cancelled = false;
    (async () => {
      await Promise.all([document.fonts.ready, loadShareLogo(), loadBrandMarks()]);
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
      await Promise.all([document.fonts.ready, loadShareLogo(), loadBrandMarks()]);
      if (cancelled) return;
      for (const v of shareVariants(data.result)) {
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

  // Animated GIF — downloadable (not copyable): X loops an *uploaded* GIF, but
  // won't animate a pasted/linked image, so the user attaches this file.
  const saveGif = async () => {
    if (!data || gifPct != null) return;
    setStatus(null);
    setGifPct(0);
    try {
      const blob = await renderCardGif(data, variant, setGifPct);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `skew-${data.underlying.toLowerCase()}-${data.result}-${variant}.gif`;
      a.click();
      URL.revokeObjectURL(url);
      flash('gif');
    } catch {
      flash('giferr');
    } finally {
      setGifPct(null);
    }
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
      const asset = data.underlying;
      const move = `${signed(data.pnlPct * 100, 1)}%`; // signed, e.g. +99.0% / -42.3%
      // The bet in plain, first-person words.
      const what = data.band
        ? `between $${price(data.band.lower)} and $${price(data.band.higher)}`
        : `${data.up ? 'above' : 'below'} $${price(data.strike)}`;
      const line =
        data.result === 'won'
          ? data.band
            ? `I just won a range bet on ${asset} — it landed ${what} (${move}) 📈`
            : `I just won a bet on ${asset} settling ${what} (${move}) 📈`
          : data.result === 'lost'
            ? data.band
              ? `So close — my range bet on ${asset} ${what} didn't land (${move}).`
              : `My bet on ${asset} settling ${what} didn't land (${move}).`
            : data.band
              ? `I'm riding a range bet on ${asset} ${what} — currently ${move} 📈`
              : `I'm riding a bet on ${asset} settling ${what} — currently ${move} 📈`;
      const text = `${line}\n\nTrade the live volatility surface on @skew_sui 👇`;
      // `url=` makes X render a link-preview card (the site's OG image), so an
      // image always rides along; a pasted card overrides it and the link stays a
      // clickable mention. No hashtags — keeps it personal.
      const intent =
        `https://twitter.com/intent/tweet` +
        `?text=${encodeURIComponent(text)}` +
        `&url=${encodeURIComponent('https://tryskew.xyz')}`;
      window.open(intent, '_blank', 'noopener,noreferrer');
    }
    flash(ok ? 'shared' : 'nocopy');
  };

  const msg =
    gifPct != null
      ? `Building GIF… ${Math.round(gifPct * 100)}%`
      : status === 'saved'
        ? 'Image saved.'
        : status === 'copied'
          ? 'Image copied to clipboard.'
          : status === 'shared'
            ? 'Post pre-filled & tagged @skew_sui — paste the card (Ctrl/⌘+V) to attach it.'
            : status === 'gif'
              ? 'GIF saved — attach it to your tweet and X will loop it.'
              : status === 'giferr'
                ? 'Couldn’t build the GIF — try Save Image instead.'
                : status === 'nocopy'
                  ? 'Clipboard unavailable — use Save Image instead.'
                  : 'Pick a style, then save, post, or grab an animated GIF.';

  const statusTone =
    status === 'nocopy' || status === 'giferr' ? 'text-warn' : status ? 'text-up' : 'text-text-3';

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
      <div className="flex flex-col gap-5">
        {/* preview — the hero of the dialog, centered and capped so the style
            grid stays visible beneath it without dominating the modal. */}
        <div className="mx-auto w-full max-w-2xl">
          <canvas
            ref={canvasRef}
            className="pointer-events-none w-full rounded-xl shadow-[0_18px_50px_-20px_rgba(0,0,0,0.8)] ring-1 ring-white/6"
            style={{ aspectRatio: '1200 / 675' }}
          />
        </div>

        {/* style picker — a compact strip of small thumbnails beneath the
            preview (the preview is the source of truth; these are quick visual
            switches). One neat row on desktop, 3×2 on mobile, labels as captions
            so the chips stay small and the modal compact. */}
        <div className="flex flex-col gap-2.5">
          <div className="flex items-baseline justify-between">
            <p className="eyebrow">Style</p>
            <p className="text-[11px] text-text-3">{variants.length} styles</p>
          </div>
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-6">
            {variants.map((v) => {
              const selected = v.id === variant;
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setVariant(v.id)}
                  aria-pressed={selected}
                  aria-label={`${v.label} style`}
                  className="group flex cursor-pointer touch-manipulation flex-col gap-1.5"
                >
                  <span
                    className={`relative block overflow-hidden rounded-md transition-all ${
                      selected
                        ? 'ring-2 ring-(--accent-line) shadow-[0_0_18px_-6px_var(--accent-glow)]'
                        : 'ring-1 ring-white/8 group-hover:ring-white/20'
                    }`}
                  >
                    <canvas
                      ref={(el) => {
                        thumbRefs.current[v.id] = el;
                      }}
                      className="pointer-events-none block w-full"
                      style={{ aspectRatio: '1200 / 675' }}
                    />
                    {selected && (
                      <span className="pointer-events-none absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-up text-bg-0">
                        <LuCheck size={10} strokeWidth={3} />
                      </span>
                    )}
                  </span>
                  <span
                    className={`text-center text-[10.5px] font-medium leading-none ${
                      selected ? 'text-up' : 'text-text-3 group-hover:text-text-2'
                    }`}
                  >
                    {v.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* footer row — hint + actions, centered */}
      <div className="mt-5 flex flex-col items-center gap-3">
        <p className={`min-h-4 text-center font-sans text-[11px] leading-snug ${statusTone}`}>
          {msg}
        </p>
        <div className="grid w-full grid-cols-2 gap-2.5 sm:flex sm:flex-wrap sm:items-center sm:justify-center">
          <button
            onClick={save}
            disabled={gifPct != null}
            className="ctrl-soft inline-flex w-full items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-[12px] font-medium text-text-1 disabled:opacity-60 sm:w-auto"
          >
            {status === 'saved' ? <LuCheck size={14} /> : <LuDownload size={14} />}
            Save Image
          </button>
          <button
            onClick={saveGif}
            disabled={gifPct != null}
            className="ctrl-soft inline-flex w-full items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-[12px] font-medium text-text-1 disabled:opacity-60 sm:w-auto"
          >
            {gifPct != null ? (
              <span className="font-mono tabular-nums">{Math.round(gifPct * 100)}%</span>
            ) : (
              <>
                <LuImagePlay size={14} />
                Download GIF
              </>
            )}
          </button>
          <button
            onClick={copy}
            disabled={gifPct != null}
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
    </Modal>
  );
}
