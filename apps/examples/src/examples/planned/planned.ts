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
 * (`/examples/<slug>`). Each follow-up ticket replaces one row with a page of its own.
 */
export const PLANNED_EXAMPLES: Readonly<Record<string, PlannedExample>> = {
  chart: {
    title: { en: "Events per minute", sr: "Događaji po minutu" },
    summary: {
      en: "Events per minute by type, drawn as a UDC chart that moves while the simulator runs.",
      sr: "Događaji po minutu po tipu, nacrtani kao UDC grafikon koji se pomera dok simulator radi.",
    },
  },
};

/** `value` in `locale`, English when the table has no such language. */
export function localized(value: Localized, locale: string): string {
  return locale === "sr" ? value.sr : value.en;
}
