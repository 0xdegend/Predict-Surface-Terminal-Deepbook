'use client';

/**
 * SessionShareModal — a finished Autopilot run as a card to post.
 *
 * Opens on its own the moment a finished run's log clears with every trade settled
 * (the panel hands it the saved result), and from the Share button on any saved run
 * in Results. Same flow as the other share dialogs: paint the card on a canvas,
 * preview it large, pick a style from the rail, and Save / Copy / Share on X.
 *
 * X's web intent can't attach an upload, so "Share on X" copies the image to the
 * clipboard and opens the composer with prefilled text — the user pastes it in.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { LuDownload, LuCopy, LuCheck } from 'react-icons/lu';
import { FaXTwitter } from 'react-icons/fa6';
import { Modal } from '@/app/_components/ui/modal';
import type { RunResult } from '@/lib/store/autopilot-store';
import {
  buildSessionShare,
  sessionShareKinds,
  sessionShareText,
  type SessionShareKind,
} from '@/lib/share/autopilot-share';
import { loadShareArt } from '@/app/_components/v2/share/share-kit';
import { drawSessionShareCard } from './session-share-cards';

const LABEL: Record<SessionShareKind, string> = {
  session: 'Session',
  curve: 'Trade by trade',
  best_trade: 'Best call',
};
const FILE: Record<SessionShareKind, string> = {
  session: 'skew-autopilot-session.png',
  curve: 'skew-autopilot-trades.png',
  best_trade: 'skew-autopilot-best-call.png',
};

export function SessionShareModal({
  run,
  context,
  onClose,
}: {
  /** The saved run to share; null keeps the dialog closed. */
  run: RunResult | null;
  /** 'finished' = it just ended (the dialog opened itself); 'results' = opened from the archive. */
  context: 'finished' | 'results';
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const thumbRefs = useRef<Record<string, HTMLCanvasElement | null>>({});
  /**
   * The style the trader picked, remembered against the run it was picked FOR, so a
   * different run opens on its headline card without an effect resetting anything:
   * a choice made for another run simply does not apply to this one.
   */
  const [choice, setChoice] = useState<{ runId: string; kind: SessionShareKind } | null>(null);
  const [status, setStatus] = useState<null | 'saved' | 'copied' | 'shared' | 'nocopy'>(null);
  const open = run !== null;

  const data = useMemo(() => (run ? buildSessionShare(run) : null), [run]);
  const kinds = useMemo(() => (data ? sessionShareKinds(data) : []), [data]);
  const picked = run && choice?.runId === run.id ? choice.kind : 'session';
  // A style the run cannot fill (no wins → no best call) falls back to the session.
  const effKind: SessionShareKind = kinds.includes(picked) ? picked : 'session';
  const setKind = (k: SessionShareKind) => {
    if (run) setChoice({ runId: run.id, kind: k });
  };

  // Repaint the large preview whenever the dialog opens or the style changes.
  useEffect(() => {
    if (!open || !data) return;
    let cancelled = false;
    (async () => {
      await loadShareArt();
      if (cancelled || !canvasRef.current) return;
      setStatus(null);
      drawSessionShareCard(canvasRef.current, data, { kind: effKind });
    })();
    return () => {
      cancelled = true;
    };
  }, [open, data, effKind]);

  // Paint every style's thumbnail once the dialog opens.
  useEffect(() => {
    if (!open || !data || kinds.length < 2) return;
    let cancelled = false;
    (async () => {
      await loadShareArt();
      if (cancelled) return;
      for (const k of kinds) {
        const el = thumbRefs.current[k];
        if (el) drawSessionShareCard(el, data, { kind: k, scale: 0.5 });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, data, kinds]);

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
    a.download = FILE[effKind];
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
      // `url=` makes X render a link-preview card (the site OG image) so an image
      // rides along; a pasted card overrides it. No hashtags — keeps it personal.
      const intent =
        `https://twitter.com/intent/tweet` +
        `?text=${encodeURIComponent(sessionShareText(data, effKind))}` +
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
            : kinds.length > 1
              ? 'Pick a style, then save it, copy it, or post it on X.'
              : 'Save it, copy it, or post it on X.';

  const statusTone = status === 'nocopy' ? 'text-warn' : status ? 'text-up' : 'text-text-3';

  const justFinished = context === 'finished';
  const title = justFinished ? 'Session complete' : 'Share this run';
  // A run only reaches the archive once it has traded, so a finished run always has a story.
  const subtitle = justFinished ? 'Every trade has settled. Here is how Kelly did, ready to post.' : 'A card to post on X';
  const rail = kinds.length > 1;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      maxWidthClass={rail ? 'max-w-4xl' : 'max-w-2xl'}
      variant="glass"
      contentClassName="px-5 pb-5"
    >
      <div className="flex flex-col gap-5 sm:flex-row">
        <div className="w-full sm:flex-1 sm:self-center">
          <canvas
            ref={canvasRef}
            aria-label="Autopilot session share card preview"
            className="pointer-events-none w-full rounded-xl shadow-[0_18px_50px_-20px_rgba(0,0,0,0.8)] ring-1 ring-white/6"
            style={{ aspectRatio: '1200 / 675' }}
          />
        </div>

        {/* right rail — style picker (only when the run can fill more than one card) */}
        {rail && (
          <div className="flex w-full shrink-0 flex-col gap-2.5 sm:w-57.5">
            <p className="eyebrow">Style</p>
            {kinds.map((k) => {
              const selected = k === effKind;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  aria-pressed={selected}
                  aria-label={`${LABEL[k]} style`}
                  className={`group relative cursor-pointer touch-manipulation overflow-hidden rounded-lg transition-all ${
                    selected
                      ? 'ring-2 ring-(--accent-line) shadow-[0_0_24px_-8px_var(--accent-glow)]'
                      : 'ring-1 ring-white/6 hover:ring-white/15'
                  }`}
                >
                  <canvas
                    ref={(el) => {
                      thumbRefs.current[k] = el;
                    }}
                    className="pointer-events-none block w-full"
                    style={{ aspectRatio: '1200 / 675' }}
                  />
                  <span
                    className={`pointer-events-none absolute bottom-1.5 left-2 text-[11px] font-medium drop-shadow ${
                      selected ? 'text-up' : 'text-text-1'
                    }`}
                  >
                    {LABEL[k]}
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
        )}
      </div>

      <div className="mt-5 flex flex-col items-center gap-3">
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
    </Modal>
  );
}
