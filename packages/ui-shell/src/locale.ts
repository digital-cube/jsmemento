import { isLocale, LOCALE_STORAGE_KEY, type Locale, storage } from "@jsudc/react";

/**
 * The router's base: `/en` when the page was opened under `/en/` (the server serves the
 * site there too, so the links people already have keep working), `/` otherwise.
 */
export function routerBasename(pathname: string): string {
  return /^\/en(\/|$)/.test(pathname) ? "/en" : "/";
}

/** The language the visitor picked last (the header's EN / SR), `en` the first time. */
export function storedLocale(): Locale {
  const stored = storage.get(LOCALE_STORAGE_KEY);
  return isLocale(stored) ? stored : "en";
}

/** Remembers the header's language for the next visit. */
export function storeLocale(locale: Locale): void {
  storage.set(LOCALE_STORAGE_KEY, locale);
}
