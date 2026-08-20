'use client';

/**
 * SideButton — the UP / DOWN call, used by BOTH the simple ticket and every round card
 * so there is exactly one call button in the product rather than two that drift apart.
 *
 * Just the call: no multiplier, no payout. Those numbers churn on every tick, and a
 * button that reflows under the cursor is a button you misclick — the ticket shows the
 * payout in a settled row beneath the amount, and the confirm step states it again.
 *
 * Styling is `.glass-side` (see globals.css), the button-scale member of the app's glass
 * family: translucent fill, top-light, hairline, and a directional wash blooming from
 * the button's own edge — up from the bottom, down from the top — so the side reads
 * before the label does.
 */
import { LuArrowUp, LuArrowDown } from 'react-icons/lu';

export function SideButton({
  isUp,
  onPick,
  disabled,
  /** The side can't currently be priced — the button says so instead of going quiet. */
  unpriceable = false,
  size = 'md',
}: {
  isUp: boolean;
  onPick: () => void;
  disabled: boolean;
  unpriceable?: boolean;
  size?: 'sm' | 'md';
}) {
  const Arrow = isUp ? LuArrowUp : LuArrowDown;
  const big = size === 'md';
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      className={`glass-side ${isUp ? 'up' : 'down'} flex flex-col items-center justify-center gap-1 ${
        big ? 'px-3 py-3.5' : 'px-2.5 py-2.5'
      }`}
    >
      <span
        className={`flex items-center gap-2 font-bold ${big ? 'text-[15px]' : 'text-[13px]'} ${
          isUp ? 'text-up' : 'text-down'
        }`}
      >
        <Arrow size={big ? 17 : 15} />
        {isUp ? 'UP' : 'DOWN'}
      </span>
      {unpriceable && <span className="text-[10px] leading-none text-text-3">too one-sided to price</span>}
    </button>
  );
}
