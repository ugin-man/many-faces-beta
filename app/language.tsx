"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { LANGUAGE_STORAGE_KEY, normalizeLanguage, translate, type Language } from "./translations";

type LanguageState = { language: Language; setLanguage: (value: Language) => void; t: (text: string) => string };
const LanguageContext = createContext<LanguageState>({ language: "en", setLanguage: () => {}, t: text => translate(text, "en") });
export function LanguageProvider({ children }: { children: ReactNode }) {
  // English is also the server-rendered default; browser locale is deliberately ignored.
  const [language, updateLanguage] = useState<Language>("en");
  useEffect(() => {
    // Hydrate a browser-only preference after matching the English server render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    try { updateLanguage(normalizeLanguage(localStorage.getItem(LANGUAGE_STORAGE_KEY))); } catch { /* Storage may be blocked. */ }
  }, []);
  const setLanguage = useCallback((value: Language) => {
    updateLanguage(value);
    try { localStorage.setItem(LANGUAGE_STORAGE_KEY, value); } catch { /* Switching still works without persistence. */ }
  }, []);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  const t = useCallback((text: string) => translate(text, language), [language]);
  return <LanguageContext.Provider value={{ language, setLanguage, t }}>{children}</LanguageContext.Provider>;
}
export function useLanguage() { return useContext(LanguageContext); }
