'use client';

/**
 * StepBar — compact two-step progress for the guided binary ticket flow,
 * shared by the legacy FlowPanel and the v2 trade ticket so both deployments
 * present the identical "① Side & level → ② Your bet" journey. Each segment is
 * a back-nav target: step 1 is always reachable, step 2 only once you've
 * advanced.
 */
export function StepBar({
  step,
  onStep,
}: {
  step: 1 | 2;
  onStep: (s: 1 | 2) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <StepSeg
        n={1}
        label="Side & level"
        active={step === 1}
        done={step > 1}
        onClick={() => onStep(1)}
        clickable
      />
      <span
        className={`h-px flex-1 transition-colors ${step > 1 ? 'bg-accent/40' : 'bg-line'}`}
      />
      <StepSeg
        n={2}
        label="Your bet"
        active={step === 2}
        done={false}
        onClick={() => onStep(2)}
        clickable={step >= 2}
      />
    </div>
  );
}

function StepSeg({
  n,
  label,
  active,
  done,
  onClick,
  clickable,
}: {
  n: number;
  label: string;
  active: boolean;
  done: boolean;
  onClick: () => void;
  clickable: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      aria-current={active ? 'step' : undefined}
      className={`flex items-center gap-1.5 text-[10px] uppercase tracking-wider transition-colors disabled:cursor-default ${
        active
          ? 'text-text-1'
          : clickable
            ? 'text-text-3 hover:text-text-2'
            : 'text-text-3'
      }`}
    >
      <span
        className={`flex h-5 w-5 items-center justify-center rounded-full border text-[10px] tabular-nums ${
          active
            ? 'border-accent/60 bg-(--accent-soft) text-accent'
            : done
              ? 'border-accent/40 text-accent'
              : 'border-line text-text-3'
        }`}
      >
        {done ? '✓' : n}
      </span>
      {label}
    </button>
  );
}
