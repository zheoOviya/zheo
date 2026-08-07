"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";

type Messages = Record<string, string>;

const I18nContext = createContext<{
  locale: string;
  setLocale: (locale: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}>({
  locale: "en",
  setLocale: () => {},
  t: (key, params) => {
    if (params) {
      return Object.entries(params).reduce(
        (str, [k, v]) => str.replace(`{${k}}`, String(v)),
        key,
      );
    }
    return key;
  },
});

export function useI18n() {
  return useContext(I18nContext);
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState("en");
  const [messages, setMessages] = useState<Messages>({});
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const stored = localStorage.getItem("snakzap-locale");
    if (stored === "en" || stored === "hi") {
      setLocaleState(stored);
    }
  }, []);

  useEffect(() => {
    if (!mounted) return;
    import(`../locales/${locale}.json`)
      .then((mod) => setMessages(mod.default as Messages))
      .catch(() => setMessages({}));
  }, [locale, mounted]);

  const setLocale = useCallback(
    (newLocale: string) => {
      setLocaleState(newLocale);
      localStorage.setItem("snakzap-locale", newLocale);
      document.documentElement.lang = newLocale;
    },
    [],
  );

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => {
      const template = messages[key] ?? key;
      if (!params) return template;
      return Object.entries(params).reduce(
        (str, [k, v]) => str.replace(`{${k}}`, String(v)),
        template,
      );
    },
    [messages],
  );

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}
