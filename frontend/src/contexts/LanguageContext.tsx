import { createContext, useContext, useState, useCallback } from 'react';
import { t as translate, Lang, TranslationKey } from '../i18n/translations';
// safeStorage matters here: this provider wraps the whole app, so a
// storage-blocked browser must degrade instead of crashing the tree.
import { safeGet, safeSet } from '../lib/safeStorage';

interface LanguageContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggleLang: () => void;
  t: (key: TranslationKey) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

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
