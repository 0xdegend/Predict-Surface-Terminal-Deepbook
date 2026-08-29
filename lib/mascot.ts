export type MascotMood = "thinking" | "confident" | "won" | "loss";

/** Mood → artwork. The fox is square; render it cropped/contained as needed. */
export const MASCOT_SRC: Record<MascotMood, string> = {
  thinking: "/skew-fox-thinking.png", // chin-stroke, deliberating with you
  confident: "/smart-fox.png", // self-assured point, "you got this"
  won: "/skew-fox-won.png", // celebrating a win / payout
  loss: "/skew-fox-loss.png", // commiserating after a miss / error
};
export const MASCOT_GLOW: Record<MascotMood, string> = {
  thinking: "var(--accent-soft)",
  confident: "var(--accent-soft)",
  won: "var(--accent-soft)",
  loss: "var(--down-soft)",
};

/** Resolve a transaction lifecycle state to a mood — keeps callers semantic. */
export function moodForTx(
  state: "review" | "pending" | "success" | "error",
): MascotMood {
  switch (state) {
    case "success":
      return "won";
    case "error":
      return "loss";
    default:
      return "thinking";
  }
}

let preloaded = false;
/**
 * Warm the browser cache for every expression on first use, so a mood swap is
 * instant (no flash) and the peek never pops in late. Idempotent; no-op on the
 * server. Cheap — four small PNGs the share card already ships.
 */
export function preloadMascots(): void {
  if (preloaded || typeof window === "undefined") return;
  preloaded = true;
  for (const src of Object.values(MASCOT_SRC)) {
    const img = new Image();
    img.src = src;
  }
}
