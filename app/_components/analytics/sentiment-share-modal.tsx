"use client";

import { useEffect, useRef, useState } from "react";
import { LuDownload, LuCheck, LuCopy, LuTriangleAlert } from "react-icons/lu";
import { Modal } from "@/app/_components/ui/modal";
import type { Sentiment } from "@/lib/analytics/flow";
import { num } from "@/lib/format";
import { siteConfig } from "@/config/site";

type Lean = "up" | "down" | "split" | "balanced";

function leanOf(s: Sentiment): Lean {
  if (s.totalCost <= 0) return "balanced";
  const up = Math.round(s.upShare * 100);
  if (up > 55) return "up";
  if (100 - up > 55) return "down";
  return "split";
}

function composeTweet(s: Sentiment): string {
  const up = Math.round(s.upShare * 100);
  const down = 100 - up;
  const tail = "Trade the shape of volatility on Sui.";
  switch (leanOf(s)) {
    case "down":
      return `📉 Sentiment is leaning DOWN — ${down}% of the last hour's bets on Skew are calling lower.\n\n↓ DOWN ${down}%    ↑ UP ${up}%\n\n${tail}`;
    case "up":
      return `📈 Sentiment is leaning UP — ${up}% of the last hour's bets on Skew are calling higher.\n\n↑ UP ${up}%    ↓ DOWN ${down}%\n\n${tail}`;
    default:
      return `⚖️ Dead heat — sentiment on Skew is split ${up}/${down} on where price goes next.\n\n${tail}`;
  }
}

export function SentimentShareModal({
  open,
  onClose,
  sentiment,
}: {
  open: boolean;
  onClose: () => void;
  sentiment: Sentiment;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState<"idle" | "ok" | "err">("idle");
  const [downloaded, setDownloaded] = useState(false);
  const [logo, setLogo] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    const img = new Image();
    img.src = "/skew-mark.png";
    img.onload = () => setLogo(img);
  }, []);

  // Draw (and redraw once the web fonts resolve, so the poster isn't rendered in
  // a fallback face on first open).
  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    const render = () => {
      if (!cancelled && canvasRef.current)
        drawSentimentCard(canvasRef.current, sentiment, logo);
    };
    render();
    document.fonts?.ready?.then(render).catch(() => {});
    setCopied("idle");
    setDownloaded(false);
    return () => {
      cancelled = true;
    };
  }, [open, sentiment, logo]);

  function shareOnX() {
    const url = `${siteConfig.url}/analytics`;
    const intent = `https://x.com/intent/tweet?text=${encodeURIComponent(
      composeTweet(sentiment),
    )}&url=${encodeURIComponent(url)}`;
    window.open(intent, "_blank", "noopener,noreferrer");
  }

  function withBlob(fn: (blob: Blob) => void) {
    canvasRef.current?.toBlob((blob) => blob && fn(blob), "image/png");
  }

  function download() {
    withBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "skew-sentiment.png";
      a.click();
      URL.revokeObjectURL(a.href);
      setDownloaded(true);
      setTimeout(() => setDownloaded(false), 1800);
    });
  }

  async function copyImage() {
    try {
      // ClipboardItem is unavailable in some browsers (e.g. Firefox) — fall back
      // to a download so the user always gets the card one way or another.
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
        download();
        return;
      }
      await new Promise<void>((resolve, reject) =>
        withBlob((blob) =>
          navigator.clipboard
            .write([new ClipboardItem({ "image/png": blob })])
            .then(resolve, reject),
        ),
      );
      setCopied("ok");
      setTimeout(() => setCopied("idle"), 1800);
    } catch {
      setCopied("err");
      setTimeout(() => setCopied("idle"), 2200);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Share sentiment"
      subtitle="Post the live sentiment to X"
      variant="glass"
      maxWidthClass="max-w-lg"
      contentClassName="px-4 pb-4 pt-1"
    >
      <div className="flex flex-col gap-3.5">
        {/* The poster — the canvas IS the preview, so what you see is exactly what
            downloads/copies. Hairline frame + soft lift to seat it on the glass. */}
        <canvas
          ref={canvasRef}
          aria-label="Sentiment share card preview"
          className="w-full rounded-xl border border-[var(--line)] shadow-[0_20px_60px_-24px_rgba(0,0,0,0.9)]"
          style={{ aspectRatio: "1200 / 675" }}
        />

        {/* Primary CTA. */}
        <button
          onClick={shareOnX}
          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-[var(--accent-line)] bg-[var(--accent-soft)] text-[13px] font-semibold tracking-tight text-up transition-shadow hover:shadow-[0_0_28px_-8px_var(--accent-glow)]"
        >
          <XGlyph size={15} />
          Share on X
        </button>

        {/* Attach helpers — an intent can't carry the image, so make grabbing it
            a single tap, then a one-line nudge on how to use it. */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={copyImage}
            className="ctrl-soft inline-flex h-10 items-center justify-center gap-2 rounded-xl text-[12px] font-medium text-text-2 hover:text-text-1"
          >
            {copied === "ok" ? (
              <>
                <LuCheck size={14} className="text-up" /> Copied
              </>
            ) : copied === "err" ? (
              <>
                <LuTriangleAlert size={14} className="text-warn" /> Couldn’t
                copy
              </>
            ) : (
              <>
                <LuCopy size={14} /> Copy image
              </>
            )}
          </button>
          <button
            onClick={download}
            className="ctrl-soft inline-flex h-10 items-center justify-center gap-2 rounded-xl text-[12px] font-medium text-text-2 hover:text-text-1"
          >
            {downloaded ? (
              <>
                <LuCheck size={14} className="text-up" /> Saved
              </>
            ) : (
              <>
                <LuDownload size={14} /> Download
              </>
            )}
          </button>
        </div>

        <p className="text-center text-[11px] leading-relaxed text-text-3">
          Copy or download the card, then attach it to your post on X.
        </p>
      </div>
    </Modal>
  );
}

/** The X (formerly Twitter) wordmark, inlined to avoid an icon-pack dependency. */
function XGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/* --------------------------- the poster renderer --------------------------- */

function hexA(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

type Pt = [number, number];

/** Shade a #rrggbb toward white (p>0) or black (p<0); p in [-1,1]. */
function shade(hex: string, p: number): string {
  const h = hex.replace("#", "");
  const t = p < 0 ? 0 : 255;
  const a = Math.abs(p);
  const mix = (c: number) => Math.round((t - c) * a + c);
  const r = mix(parseInt(h.slice(0, 2), 16));
  const g = mix(parseInt(h.slice(2, 4), 16));
  const b = mix(parseInt(h.slice(4, 6), 16));
  return `rgb(${r},${g},${b})`;
}

function fillPoly(
  ctx: CanvasRenderingContext2D,
  pts: Pt[],
  style: string | CanvasGradient,
) {
  ctx.fillStyle = style;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill();
}

/** A solid block UP arrow (apex at top), as a polygon. */
function upArrowPts(cx: number, ty: number, w: number, h: number): Pt[] {
  const hw = w * 0.5; // head half-width
  const sw = w * 0.22; // shaft half-width
  const hh = h * 0.46; // head height
  return [
    [cx, ty],
    [cx + hw, ty + hh],
    [cx + sw, ty + hh],
    [cx + sw, ty + h],
    [cx - sw, ty + h],
    [cx - sw, ty + hh],
    [cx - hw, ty + hh],
  ];
}

/** A horizontal double-headed arrow polygon (used for a dead-heat split). */
function doubleArrowPts(
  cx: number,
  cy: number,
  len: number,
  thick: number,
): Pt[] {
  const hl = len / 2;
  const ah = len * 0.22; // arrowhead length
  const hh = thick * 0.9; // head half-height
  const sh = thick * 0.4; // shaft half-height
  return [
    [cx - hl, cy],
    [cx - hl + ah, cy - hh],
    [cx - hl + ah, cy - sh],
    [cx + hl - ah, cy - sh],
    [cx + hl - ah, cy - hh],
    [cx + hl, cy],
    [cx + hl - ah, cy + hh],
    [cx + hl - ah, cy + sh],
    [cx - hl + ah, cy + sh],
    [cx - hl + ah, cy + hh],
  ];
}

/** Draw a polygon as an extruded, glossy 3-D solid with a soft directional glow.
 *  Back face + side quads (darker) seat the form in space; a diagonal gradient
 *  front face + white rim highlight give it depth and sheen. */
function draw3DSolid(
  ctx: CanvasRenderingContext2D,
  pts: Pt[],
  color: string,
  depth: Pt = [11, 16],
) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const rad =
    Math.max(
      Math.max(...xs) - Math.min(...xs),
      Math.max(...ys) - Math.min(...ys),
    ) * 0.85;

  // Ambient glow pooled under the solid.
  const g = ctx.createRadialGradient(
    cx + depth[0],
    cy + depth[1],
    0,
    cx + depth[0],
    cy + depth[1],
    rad,
  );
  g.addColorStop(0, hexA(color, 0.22));
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx + depth[0], cy + depth[1], rad, 0, Math.PI * 2);
  ctx.fill();

  const back: Pt[] = pts.map((p) => [p[0] + depth[0], p[1] + depth[1]]);
  fillPoly(ctx, back, shade(color, -0.52));
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    fillPoly(ctx, [pts[i], pts[j], back[j], back[i]], shade(color, -0.3));
  }

  // Glossy front face.
  const grad = ctx.createLinearGradient(
    Math.min(...xs),
    Math.min(...ys),
    Math.max(...xs),
    Math.max(...ys),
  );
  grad.addColorStop(0, shade(color, 0.32));
  grad.addColorStop(0.55, color);
  grad.addColorStop(1, shade(color, -0.08));
  ctx.save();
  ctx.shadowColor = hexA(color, 0.45);
  ctx.shadowBlur = 30;
  fillPoly(ctx, pts, grad);
  ctx.restore();

  // Rim light along the top edges.
  ctx.strokeStyle = hexA("#ffffff", 0.16);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.stroke();
}

function drawSentimentCard(
  canvas: HTMLCanvasElement,
  s: Sentiment,
  logo: HTMLImageElement | null,
) {
  const W = 1200;
  const H = 675;
  const SCALE = 2;
  const P = 64;
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(SCALE, SCALE);

  const root = getComputedStyle(document.documentElement);
  const sans = `${root.getPropertyValue("--font-geist-sans").trim()}, system-ui, sans-serif`;
  const mono = `${root.getPropertyValue("--font-geist-mono").trim()}, ui-monospace, monospace`;

  const C = {
    bg: "#0a0b0d",
    bg3: "#181c20",
    line: "rgba(255,255,255,0.08)",
    t1: "#e6e8eb",
    t2: "#8b9099",
    t3: "#5a5f66",
    up: "#4dd6b0",
    down: "#f0796b",
    warn: "#e6b450",
  };

  const up = Math.round(s.upShare * 100);
  const down = 100 - up;
  const lean = leanOf(s);
  const leanColor = lean === "down" ? C.down : C.up;

  // Base + a soft directional glow biased toward the side the arrow sits on.
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(
    W * 0.74,
    H * 0.5,
    0,
    W * 0.74,
    H * 0.5,
    620,
  );
  glow.addColorStop(0, hexA(lean === "split" ? C.t2 : leanColor, 0.16));
  glow.addColorStop(1, "rgba(10,11,13,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  roundRect(ctx, 0.5, 0.5, W - 1, H - 1, 0);
  ctx.stroke();

  // Brand lockup, top-left — the real Skew mark + wordmark (the mark falls back
  // to a drawn "rising bars" glyph until the image decodes).
  const markSize = 40;
  const markY = 71 - markSize / 2;
  if (logo) {
    ctx.drawImage(logo, P, markY, markSize, markSize);
  } else {
    const baseY = 84;
    [16, 26, 36].forEach((h, i) => {
      ctx.fillStyle = C.up;
      roundRect(ctx, P + i * 13, baseY - h, 8, h, 2);
      ctx.fill();
    });
  }
  ctx.fillStyle = C.t1;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.font = `600 31px ${sans}`;
  ctx.fillText("Skew", P + markSize + 14, 72);

  // TESTNET pill, top-right.
  ctx.font = `600 14px ${sans}`;
  ctx.letterSpacing = "2px";
  const tnet = "TESTNET";
  const pillW = ctx.measureText(tnet).width + 28;
  const pillH = 30;
  const pillX = W - P - pillW;
  const pillY = 70 - pillH / 2;
  ctx.fillStyle = hexA(C.warn, 0.12);
  roundRect(ctx, pillX, pillY, pillW, pillH, 8);
  ctx.fill();
  ctx.fillStyle = C.warn;
  ctx.fillText(tnet, pillX + 14, pillY + pillH / 2 + 1);
  ctx.letterSpacing = "0px";

  // The 3-D hero glyph on the right — an extruded arrow (up/down) or a
  // double-headed arrow for a dead heat. Drawn first so text never collides.
  const ax = W * 0.74;
  if (lean === "up") {
    draw3DSolid(ctx, upArrowPts(ax, 195, 200, 285), C.up);
  } else if (lean === "down") {
    // A down arrow is the up polygon mirrored about its vertical centre.
    const ty = 195;
    const h = 285;
    draw3DSolid(
      ctx,
      upArrowPts(ax, ty, 200, h).map(([x, y]) => [x, 2 * ty + h - y] as Pt),
      C.down,
    );
  } else {
    draw3DSolid(ctx, doubleArrowPts(ax, 338, 290, 64), C.t2);
  }

  // Eyebrow.
  ctx.textBaseline = "alphabetic";
  ctx.letterSpacing = "2px";
  ctx.font = `600 16px ${sans}`;
  ctx.fillStyle = C.t3;
  ctx.fillText("SENTIMENT · LAST HOUR", P, 178);
  ctx.letterSpacing = "0px";

  // Headline — small lead-in over a big lean-coloured read.
  ctx.font = `400 24px ${sans}`;
  ctx.fillStyle = C.t2;
  ctx.fillText(
    lean === "split" ? "Sentiment is" : "Sentiment is leaning",
    P,
    222,
  );

  ctx.fillStyle = lean === "up" ? C.up : lean === "down" ? C.down : C.t1;
  if (lean === "split") {
    ctx.font = `700 64px ${sans}`;
    ctx.fillText("DEAD HEAT", P, 300);
  } else {
    ctx.font = `700 76px ${sans}`;
    ctx.fillText(lean === "up" ? `${up}% UP` : `${down}% DOWN`, P, 304);
  }

  // Per-side breakdown — coloured share label + muted stake/bet count.
  const betWord = (n: number) => (n === 1 ? "bet" : "bets");
  const statLine = (
    g: CanvasRenderingContext2D,
    y: number,
    dir: "up" | "down",
    pct: number,
    cost: number,
    count: number,
  ) => {
    g.font = `600 21px ${sans}`;
    g.fillStyle = dir === "up" ? C.up : C.down;
    const label = `${dir === "up" ? "UP" : "DOWN"} ${pct}%`;
    g.fillText(label, P, y);
    // Measure the label in ITS font before switching, or the muted text overlaps.
    const labelW = g.measureText(label).width;
    g.font = `400 16px ${mono}`;
    g.fillStyle = C.t3;
    g.fillText(
      `${num(cost, 2)} DUSDC · ${count} ${betWord(count)}`,
      P + labelW + 20,
      y,
    );
  };
  statLine(ctx, 384, "up", up, s.upCost, s.upCount);
  statLine(ctx, 424, "down", down, s.downCost, s.downCount);

  // Footer.
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(P, 556);
  ctx.lineTo(W - P, 556);
  ctx.stroke();
  ctx.font = `500 18px ${mono}`;
  ctx.fillStyle = C.t2;
  const total = `${num(s.totalCost, 2)} DUSDC`;
  ctx.fillText(total, P, 606);
  // Measure in the mono font it was drawn with, then add the label after a gap.
  const totalW = ctx.measureText(total).width;
  ctx.font = `400 16px ${sans}`;
  ctx.fillStyle = C.t3;
  ctx.fillText("total volume", P + totalW + 12, 606);
  ctx.textAlign = "right";
  ctx.font = `500 16px ${sans}`;
  ctx.fillStyle = C.t3;
  ctx.fillText("Skew · DeepBook Predict on Sui", W - P, 606);
  ctx.textAlign = "left";
}
