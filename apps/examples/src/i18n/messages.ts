import type { Messages } from "@jsudc/react";

/**
 * The site's strings, layered over the library's dictionary through
 * `<UdcI18nProvider messages>`: the shell's own `APP` terms, `MENU` (the labels of
 * menu.yaml's `translation_key`s, `MENU_HOME` → `MENU.HOME`) and `COLLECTIONS` (the
 * `udc:collections` leaves, `COLLECTIONS_<NAME>`).
 */
export const EXAMPLES_MESSAGES: Messages = {
  APP: {
    NAME: { en: "memento", sr: "memento" },
    TAGLINE: { en: "examples", sr: "primeri" },
    NAV_MENU: { en: "Examples menu", sr: "Meni primera" },
    LANGUAGE: { en: "Language", sr: "Jezik" },
    SETTINGS: { en: "Settings", sr: "Podešavanja" },
    BASE_URL: { en: "API base URL", sr: "Osnovni URL API-ja" },
    API_KEY: { en: "API key", sr: "API ključ" },
    CONNECT: { en: "Connect", sr: "Poveži" },
    FORGET_KEY: { en: "Use the demo key", sr: "Koristi demo ključ" },
    KEY_DEMO: { en: "demo key", sr: "demo ključ" },
    KEY_OWN: { en: "your key", sr: "vaš ključ" },
    KEY_NONE: { en: "no key", sr: "nema ključa" },
    KEY_PENDING: { en: "connecting…", sr: "povezivanje…" },
    TENANT: { en: "tenant {tenant}", sr: "tenant {tenant}" },
    DEMO_HINT: {
      en: "The server's read-only demo key. Paste your own to replace it.",
      sr: "Serverov demo ključ, samo za čitanje. Nalepite svoj da biste ga zamenili.",
    },
    NO_KEY: {
      en: "Paste an API key with the read scope (memento create-key --tenant demo --scopes read) and press Connect.",
      sr: "Nalepite API ključ sa read opsegom (memento create-key --tenant demo --scopes read) i pritisnite Poveži.",
    },
  },
  MENU: {
    HOME: { en: "Home", sr: "Početna" },
    EXAMPLES: { en: "Examples", sr: "Primeri" },
    CPU_MONITOR: { en: "CPU monitor", sr: "CPU monitor" },
    COLLECTIONS: { en: "Collections", sr: "Kolekcije" },
  },
  COLLECTIONS: {
    EVENTS: { en: "events", sr: "events" },
    CPU_LOAD: { en: "cpu_load", sr: "cpu_load" },
    MENU: { en: "menu", sr: "menu" },
  },
};
