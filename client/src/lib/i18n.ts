import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'summ_lang';
const EVENT = 'summ-lang-changed';

export function getLang(): string {
  return localStorage.getItem(STORAGE_KEY) || 'ko';
}

/** t(ko, en) — returns the string for the current language */
export function useLang(): {
  lang: string;
  t: (ko: string, en: string) => string;
  setLang: (next: string) => void;
} {
  const [lang, setLang] = useState<string>(getLang);

  useEffect(() => {
    const sync = () => setLang(getLang());
    // storage: fires across documents; EVENT: fires within this document
    window.addEventListener('storage', sync);
    window.addEventListener('focus', sync);
    window.addEventListener(EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('focus', sync);
      window.removeEventListener(EVENT, sync);
    };
  }, []);

  const t = useCallback((ko: string, en: string): string => (lang === 'en' ? en : ko), [lang]);

  /** setLang — persists to localStorage and notifies every page instantly */
  const changeLang = useCallback((next: string): void => {
    const v = next === 'en' ? 'en' : 'ko';
    localStorage.setItem(STORAGE_KEY, v);
    setLang(v);
    window.dispatchEvent(new Event(EVENT));
  }, []);

  return { lang, t, setLang: changeLang };
}