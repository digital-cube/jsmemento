/** A string in each language of the site. */
export interface Localized {
  en: string;
  sr: string;
}

export interface PlannedExample {
  title: Localized;
  summary: Localized;
}

/**
 * The examples of menu.yaml that are not built yet, by the slug of their route
 * (`/examples/<slug>`). Each follow-up ticket replaced one row with a page of its own; every
 * example of the series is built now, the table stays for the next one.
 */
export const PLANNED_EXAMPLES: Readonly<Record<string, PlannedExample>> = {};

/** `value` in `locale`, English when the table has no such language. */
export function localized(value: Localized, locale: string): string {
  return locale === "sr" ? value.sr : value.en;
}
