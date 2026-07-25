'use client';

/**
 * The Plain / Pro vocabulary layer for the BTC Options page.
 *
 * Same page, two audiences: a first-timer reads "how jumpy the market is", a
 * trader reads "implied vol". Wrap the page in <VocabProvider>, write copy with
 * <Term plain="…" pro="…" />, and drop <VocabToggle> in the header. The engine's
 * numbers never change — only the words around them.
 */
import { createContext, useContext, useState, type ReactNode } from 'react';

type VocabMode = 'plain' | 'pro';

const VocabCtx = createContext<{ mode: VocabMode; setMode: (m: VocabMode) => void }>({
  mode: 'plain',
  setMode: () => {},
});

export function VocabProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<VocabMode>('plain');
  return <VocabCtx.Provider value={{ mode, setMode }}>{children}</VocabCtx.Provider>;
}

export const useVocab = () => useContext(VocabCtx);

/** Renders the plain or pro wording for the current mode. */
export function Term({ plain, pro }: { plain: string; pro: string }) {
  const { mode } = useVocab();
  return <>{mode === 'pro' ? pro : plain}</>;
}

/** The Plain / Pro segmented toggle. */
export function VocabToggle() {
  const { mode, setMode } = useVocab();
  return (
    <div className="inline-flex gap-0.5 rounded-lg border border-line bg-bg-2 p-0.5" role="group" aria-label="Vocabulary">
      {(['plain', 'pro'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => setMode(m)}
          aria-pressed={mode === m}
          className={`rounded-md px-3 py-1 text-[12px] capitalize transition ${
            mode === m ? 'bg-(--accent-soft) text-accent ring-1 ring-inset ring-(--accent-line)' : 'text-text-2 hover:text-text-1'
          }`}
        >
          {m}
        </button>
      ))}
    </div>
  );
}
