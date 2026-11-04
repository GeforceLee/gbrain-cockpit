import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { en } from "../locales/en";
import { zhCN } from "../locales/zh-CN";

// Bilingual UI is a V1-from-day-one capability, not an enhancement
// (FEATURES §4.0): browser locale by default, manual switch persisted.
// MessageKey comes from the zh-CN pack and both packs are typed
// Record<MessageKey, string>, so a missing key in either pack is a compile
// error — `scripts/check-locales.ts` is the CI-visible belt to that brace.

export type Locale = "zh-CN" | "en";
export type MessageKey = keyof typeof zhCN;

const PACKS: Record<Locale, Record<MessageKey, string>> = {
  "zh-CN": zhCN,
  en,
};

const STORAGE_KEY = "cockpit.lang";

function detectLocale(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "zh-CN" || stored === "en") return stored;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

interface I18n {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey) => string;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, locale);
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => setLocaleState(next), []);
  const t = useCallback(
    (key: MessageKey) => PACKS[locale][key] ?? key,
    [locale],
  );

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}
