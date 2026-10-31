import type { Messages } from "@jsudc/react";

/**
 * The site's strings, layered over the library's dictionary through
 * `<UdcI18nProvider messages>`: the shell's own `APP` terms, `MENU` (the labels of
 * menu.yaml's `translation_key`s, `MENU_HOME` → `MENU.HOME`), the pages' own (`ACTIVITY`,
 * `ENTITY`, `CHAT`, `PLANNED`) and `COLLECTIONS` (the `udc:collections` leaves, `COLLECTIONS_<NAME>`).
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
    ENTITY: { en: "Entity timeline", sr: "Istorija entiteta" },
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
  ENTITY: {
    TITLE: { en: "Entity timeline", sr: "Istorija entiteta" },
    SUBTITLE: {
      en: "What happened to this object? Pick an instance of the tenant's events",
      sr: "Šta se desilo ovom objektu? Izaberite instancu iz događaja tenanta",
    },
    TIMELINE_SUB: {
      en: "UDC events of one instance · newest on top · live",
      sr: "UDC događaji jedne instance · najnoviji na vrhu · uživo",
    },
    TYPES: { en: "Instance types", sr: "Tipovi instanci" },
    RECENT: { en: "Recently active {type} instances", sr: "Nedavno aktivne instance tipa {type}" },
    COUNT: { en: "{count} events", sr: "događaja: {count}" },
    COUNT_ONE: { en: "1 event", sr: "događaja: 1" },
    BY_HAND: { en: "Or type one", sr: "Ili ukucajte" },
    TYPE: { en: "Instance type", sr: "Tip instance" },
    ID: { en: "Instance id", sr: "ID instance" },
    OPEN: { en: "Open timeline", sr: "Otvori istoriju" },
    ALL: { en: "← All instances", sr: "← Sve instance" },
    SUMMARY: {
      en: "First seen {first} · last seen {last} · {count} events · {actors} actors",
      sr: "Prvi put {first} · poslednji put {last} · događaja: {count} · aktera: {actors}",
    },
    MORE: { en: "Older events", sr: "Stariji događaji" },
    EMPTY: {
      en: "Nothing has happened to {instance} yet: memento has no events for it.",
      sr: "Instanci {instance} se još ništa nije desilo: memento nema događaja za nju.",
    },
    PICK: { en: "Pick another instance", sr: "Izaberite drugu instancu" },
    NONE: {
      en: "No instances yet: the tenant has no events. memento simulate pushes a ticket desk story — start it with",
      sr: "Još nema instanci: tenant nema događaja. memento simulate šalje priču o službi za tikete — pokrenite ga sa",
    },
  },
  CHAT: {
    TITLE: { en: "Chat", sr: "Čet" },
    SUBTITLE: {
      en: "MementoChat · the simulator's demo room · read-only · live",
      sr: "MementoChat · demo soba simulatora · samo čitanje · uživo",
    },
    ROOM: { en: "Demo room", sr: "Demo soba" },
    VIEW_AS: { en: "Viewing as", sr: "Gledate kao" },
    VIEW_AS_HINT: {
      en: "Chat reads are per participant (user_id): switch to see who has read what from their side.",
      sr: "Čet se čita u ime učesnika (user_id): promenite učesnika da vidite ko je šta pročitao iz njegovog ugla.",
    },
    MEMBERS: { en: "{count} participants", sr: "učesnika: {count}" },
    READ_ONLY_DEMO: { en: "read-only demo key", sr: "demo ključ samo za čitanje" },
    READ_ONLY: { en: "read-only example", sr: "primer samo za čitanje" },
    EMPTY: {
      en: "The demo room does not exist yet: memento simulate creates it and talks in it — start it with",
      sr: "Demo soba još ne postoji: pravi je memento simulate, koji u njoj i piše — pokrenite ga sa",
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
