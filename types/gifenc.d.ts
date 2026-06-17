// Minimal ambient types for `gifenc` (the package ships no .d.ts). Covers only
// the surface we use in animated-share-card.ts.
declare module 'gifenc' {
  interface WriteFrameOpts {
    palette?: number[][];
    /** Frame duration in ms. */
    delay?: number;
    /** Loop count; 0 = forever (set on the first frame). */
    repeat?: number;
    transparent?: boolean;
    dispose?: number;
    first?: boolean;
  }
  interface GifEncoder {
    writeFrame(index: Uint8Array | number[], width: number, height: number, opts?: WriteFrameOpts): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    reset(): void;
  }
  export function GIFEncoder(): GifEncoder;
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: Record<string, unknown>,
  ): number[][];
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: string,
  ): Uint8Array;
}
