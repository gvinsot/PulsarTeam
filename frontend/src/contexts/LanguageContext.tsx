import { createContext, useContext, useState, useCallback } from 'react';
import { t as translate, Lang, TranslationKey } from '../i18n/translations';

interface LanguageContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggleLang: () => void;
  t: (key: TranslationKey) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

// localStorage can throw (cookies blocked for the site, sandboxed webviews) —
// this provider wraps the whole app, so degrade instead of crashing the tree.
const safeGet = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const safeSet = (key: string, value: string): void => {
  try { localStorage.setItem(key, value); } catch { /* storage blocked */ }
};

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const saved = safeGet('pulsar_lang');
    if (saved === 'fr' || saved === 'en') return saved;
    // Auto-detect from browser
    const browserLang = navigator.language?.toLowerCase() || '';
    return browserLang.startsWith('fr') ? 'fr' : 'en';
  });

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    safeSet('pulsar_lang', l);
  }, []);

  const toggleLang = useCallback(() => {
    setLangState(prev => {
      const next = prev === 'en' ? 'fr' : 'en';
      safeSet('pulsar_lang', next);
      return next;
    });
  }, []);

  const t = useCallback((key: TranslationKey) => translate(key, lang), [lang]);

  return (
    <LanguageContext.Provider value={{ lang, setLang, toggleLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider');
  return ctx;
}
