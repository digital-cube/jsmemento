import type { Messages } from "@jsudc/react";

/**
 * The site's strings, layered over the library's dictionary through
 * `<UdcI18nProvider messages>`: the shell's own `APP` terms, `MENU` (the labels of
 * menu.yaml's `translation_key`s, `MENU_HOME` → `MENU.HOME`), the pages' own (`ACTIVITY`,
 * `PLANNED`) and `COLLECTIONS` (the `udc:collections` leaves, `COLLECTIONS_<NAME>`).
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
    ACTIVITY: { en: "Activity feed", sr: "Tok aktivnosti" },
    ENTITY: { en: "Entity history", sr: "Istorija entiteta" },
    CHAT: { en: "Chat", sr: "Čet" },
    TAIL: { en: "Live tail", sr: "Uživo praćenje" },
    SEARCH: { en: "Search", sr: "Pretraga" },
    RENDERING: { en: "Rendering", sr: "Prikaz teksta" },
    CHART: { en: "Events per minute", sr: "Događaji po minutu" },
    COLLECTIONS: { en: "Collections", sr: "Kolekcije" },
  },
  ACTIVITY: {
    TITLE: { en: "Activity feed", sr: "Tok aktivnosti" },
    SUBTITLE: {
      en: "UDC events · rendered by memento in the page's language · live",
      sr: "UDC events · tekst renderuje memento na jeziku stranice · uživo",
    },
    LIVE: { en: "Live", sr: "Uživo" },
    CONNECTING: { en: "Connecting…", sr: "Povezivanje…" },
    OFFLINE: { en: "Offline", sr: "Van mreže" },
    LAST_EVENT: { en: "last event", sr: "poslednji događaj" },
    EVENTS: { en: "events", sr: "događaja" },
    MORE: { en: "Older events", sr: "Stariji događaji" },
    EMPTY: {
      en: "No activity yet: these events are pushed by memento simulate, a ticket desk story — start it with",
      sr: "Još nema aktivnosti: ove događaje šalje memento simulate, priča o službi za tikete — pokrenite ga sa",
    },
  },
  PLANNED: {
    BADGE: { en: "Planned", sr: "Planirano" },
    LEAD: {
      en: "This example is planned and not built yet. It will show:",
      sr: "Ovaj primer je planiran i još nije napravljen. Prikazaće:",
    },
    BACK: { en: "← Back to the activity feed", sr: "← Nazad na tok aktivnosti" },
  },
  COLLECTIONS: {
    EVENTS: { en: "events", sr: "events" },
    CPU_LOAD: { en: "cpu_load", sr: "cpu_load" },
    MENU: { en: "menu", sr: "menu" },
  },
};
