import { createContext, use } from 'react';
import type { SearchLook } from '../server/api.ts';
import type { Lang, Texts } from './texts.ts';

export type Theme = 'light' | 'dark';

export interface Prefs {
  t: Texts;
  lang: Lang;
  setLang: (l: Lang) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  search: SearchLook;
  setSearch: (s: SearchLook) => void;
}

export const PrefsContext = createContext<Prefs | null>(null);

export function usePrefs(): Prefs {
  const p = use(PrefsContext);
  if (!p) throw new Error('PrefsProvider missing');
  return p;
}
