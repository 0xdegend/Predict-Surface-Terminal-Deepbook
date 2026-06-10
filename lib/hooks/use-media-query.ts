import { useEffect, useState } from 'react';

/**
 * SSR-safe media-query subscription. Returns `false` on the server and on the
 * first client paint (so SSR and hydration agree), then flips to the real match
 * after mount and stays live across viewport changes. Use for layout decisions
 * that need a concrete JS value — e.g. a responsive page size — that CSS alone
 * can't express.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
