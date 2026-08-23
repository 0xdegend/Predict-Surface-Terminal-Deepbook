'use client';

/**
 * The Plain / Pro layer for the BTC Options page.
 *
 * Same engine, two audiences. It started as a vocabulary swap — "how jumpy the market
 * is" versus "implied vol" — but a first-timer and a desk trader do not want the same
 * PAGE, only the same numbers underneath. So `mode` now drives three things:
 *
 *   1. wording, via <Term plain="…" pro="…" />
 *   2. how much is on screen (Plain hides the screener, the multi-leg builder and the
 *      positioning deck; Pro shows everything)
 *   3. how much is in each table (Plain: strike, chance, payout — Pro adds implied vol,
 *      edge and expected value)
 *
 * The choice STICKS. It is written to localStorage and can be linked to with `?mode=pro`,
 * because a returning trader re-picking Pro on every visit is the kind of small tax that
 * makes a page feel like it does not know them. Both are read after mount so the server
 * and the first client render always agree on Plain.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type VocabMode = 'plain' | 'pro';

const STORAGE_KEY = 'skew.options.vocab';

const VocabCtx = createContext<{ mode: VocabMode; pro: boolean; setMode: (m: VocabMode) => void }>({
  mode: 'plain',
  pro: false,
  setMode: () => {},
});

/** `?mode=pro` in the URL, else the remembered choice, else Plain. Read on the client
 *  only — the server has neither, and disagreeing with it would be a hydration error. */
function storedMode(): VocabMode | null {
  try {
    const url = new URLSearchParams(window.location.search).get('mode');
    if (url === 'pro' || url === 'plain') return url;
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'pro' || saved === 'plain' ? saved : null;
  } catch {
    return null;
  }
}

export function VocabProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<VocabMode>('plain');

  useEffect(() => {
    const saved = storedMode();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot sync from storage/URL
    if (saved && saved !== 'plain') setModeState(saved);
  }, []);

  const setMode = (m: VocabMode) => {
    setModeState(m);
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {
      /* private mode — the choice just lasts this visit */
    }
  };

  return <VocabCtx.Provider value={{ mode, pro: mode === 'pro', setMode }}>{children}</VocabCtx.Provider>;
}

export const useVocab = () => useContext(VocabCtx);

/** Renders the plain or pro wording for the current mode. */
export function Term({ plain, pro }: { plain: string; pro: string }) {
  const { mode } = useVocab();
  return <>{mode === 'pro' ? pro : plain}</>;
}

/** Renders its children only in Pro. The page's one gate for depth. */
export function ProOnly({ children }: { children: ReactNode }) {
  const { pro } = useVocab();
  return pro ? <>{children}</> : null;
}

/** Renders its children only in Plain. */
export function PlainOnly({ children }: { children: ReactNode }) {
  const { pro } = useVocab();
  return pro ? null : <>{children}</>;
}

/** The Plain / Pro segmented toggle. */
export function VocabToggle() {
  const { mode, setMode } = useVocab();
  return (
    <div className="inline-flex gap-0.5 rounded-lg border border-line bg-bg-2 p-0.5" role="group" aria-label="Detail level">
      {(['plain', 'pro'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => setMode(m)}
          aria-pressed={mode === m}
          title={m === 'plain' ? 'The essentials, in plain words' : 'Every number: implied vol, edge, expected value, the screener and the builder'}
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
