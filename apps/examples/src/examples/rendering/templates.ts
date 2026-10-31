/**
 * The Handlebars templates memento ships (`packages/server/templates/<EVENT_TYPE>.<locale>.hbs`),
 * imported as text when the site is built — the same files the server renders with. There is
 * no endpoint that serves template sources; a tenant's own templates (`memento create-template`)
 * live in the database and are not visible here.
 */

/** The locales of the site, and of every bundled template. */
export const TEMPLATE_LOCALES = ["en", "sr"] as const;
export type TemplateLocale = (typeof TEMPLATE_LOCALES)[number];

/** One event type's bundled sources, per locale (`null`: none for that locale). */
export type TemplatePair = Record<TemplateLocale, string | null>;

/** The template of event types that have none of their own. */
export const GENERIC = "_generic";

/** `TICKET_CLOSED.en.hbs`, `_generic.sr.hbs` — the server's own file pattern (renderer.ts). */
const TEMPLATE_FILE_RE = /([A-Z][A-Z0-9_]*|_generic)\.([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\.hbs$/;

/** Path → source, as `import.meta.glob` hands them over, into event type → `{en, sr}`. */
export function templatesFrom(
  modules: Readonly<Record<string, string>>,
): Record<string, TemplatePair> {
  const out: Record<string, TemplatePair> = {};
  for (const [path, source] of Object.entries(modules)) {
    const m = TEMPLATE_FILE_RE.exec(path);
    if (!m) continue;
    const [, type = "", locale = ""] = m;
    if (!(TEMPLATE_LOCALES as readonly string[]).includes(locale)) continue;
    out[type] ??= { en: null, sr: null };
    out[type][locale as TemplateLocale] = source.replace(/\n+$/, "");
  }
  return out;
}

/** Every bundled template file, by path, as text (Vite's `?raw`, resolved at build time). */
export const TEMPLATE_FILES: Readonly<Record<string, string>> = import.meta.glob<string>(
  "../../../../../packages/server/templates/*.hbs",
  { query: "?raw", import: "default", eager: true },
);

const ALL = templatesFrom(TEMPLATE_FILES);

/** The event types with a bundled template, alphabetical (`_generic` is not one of them). */
export const TEMPLATE_TYPES: readonly string[] = Object.keys(ALL)
  .filter((type) => type !== GENERIC)
  .sort();

/** The bundled sources of `type`, or `null` when memento ships none for it. */
export function bundledTemplate(type: string): TemplatePair | null {
  return type === GENERIC ? null : (ALL[type] ?? null);
}

/** `_generic`'s bundled sources. */
export const GENERIC_TEMPLATE: TemplatePair = ALL[GENERIC] ?? { en: null, sr: null };

/** The type the page opens on when the URL names none (or one without a template). */
export const DEFAULT_TYPE = "TICKET_CREATED";

export function chosenType(wanted: string | null): string {
  if (wanted && TEMPLATE_TYPES.includes(wanted)) return wanted;
  return TEMPLATE_TYPES.includes(DEFAULT_TYPE) ? DEFAULT_TYPE : (TEMPLATE_TYPES[0] ?? DEFAULT_TYPE);
}

const MUSTACHE_RE = /(\{\{[\s\S]*?\}\})/;
const PAYLOAD_REF_RE = /(\bpayload\.[A-Za-z_$][\w$]*)/;

/**
 * The payload keys a template reads: every `payload.<key>` inside a `{{…}}` — in an output
 * (`{{payload.title}}`), a block (`{{#if payload.resolution}}`) or a helper's argument
 * (`{{default payload.user_id actor_id}}`). Each key once, in the order they first appear.
 */
export function payloadKeys(source: string | null): string[] {
  if (!source) return [];
  const keys: string[] = [];
  for (const tag of source.split(MUSTACHE_RE)) {
    if (!tag.startsWith("{{")) continue;
    for (const m of tag.matchAll(/\bpayload\.([A-Za-z_$][\w$]*)/g)) {
      const key = m[1] as string;
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/** A piece of a template's source, for showing it: plain text, a `{{…}}` tag, or a `payload.x` in one. */
export interface SourcePart {
  kind: "text" | "tag" | "payload";
  text: string;
}

/** `source` cut into its text, its tags and the payload references inside the tags. */
export function sourceParts(source: string): SourcePart[] {
  const parts: SourcePart[] = [];
  for (const piece of source.split(MUSTACHE_RE)) {
    if (piece === "") continue;
    if (!piece.startsWith("{{")) {
      parts.push({ kind: "text", text: piece });
      continue;
    }
    for (const bit of piece.split(PAYLOAD_REF_RE)) {
      if (bit === "") continue;
      parts.push({ kind: PAYLOAD_REF_RE.test(bit) ? "payload" : "tag", text: bit });
    }
  }
  return parts;
}

/** One top-level member of a payload, pretty-printed, and whether the templates read it. */
export interface PayloadEntry {
  key: string;
  /** `"key": value` with the value as `JSON.stringify(…, null, 2)` writes it, indented. */
  text: string;
  used: boolean;
}

/** The members of `payload`, each marked when one of `keys` names it. */
export function payloadEntries(payload: unknown, keys: readonly string[]): PayloadEntry[] {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return [];
  return Object.entries(payload as Record<string, unknown>).map(([key, value]) => ({
    key,
    text: `${JSON.stringify(key)}: ${JSON.stringify(value, null, 2).replace(/\n/g, "\n  ")}`,
    used: keys.includes(key),
  }));
}

/**
 * Where memento looks for the template of `type` in `locale`, in order (docs/TEMPLATES.md):
 * the locale chain (the locale, its parents, then the default `en`) for the type itself,
 * then the same chain for `_generic`, then the built-in line. At every step a tenant's own
 * template beats the bundled one.
 */
export function lookupChain(type: string, locale: string, defaultLocale = "en"): string[] {
  const chain: string[] = [];
  const parts = locale.split("-");
  for (let i = parts.length; i > 0; i--) chain.push(parts.slice(0, i).join("-"));
  if (!chain.includes(defaultLocale)) chain.push(defaultLocale);
  return [...chain.map((l) => `${type}.${l}`), ...chain.map((l) => `${GENERIC}.${l}`)];
}

/** What renders when not even `_generic` exists (or a template fails at render time). */
export const BUILTIN_FORMAT = "{{event_type}}: {{instance_type}}/{{instance_id}}";

/** The step of `lookupChain` the bundled templates answer (no tenant template assumed). */
export function bundledStep(type: string, locale: string): string | null {
  for (const step of lookupChain(type, locale)) {
    const dot = step.lastIndexOf(".");
    const pair = ALL[step.slice(0, dot)];
    const source = pair?.[step.slice(dot + 1) as TemplateLocale];
    if (source) return step;
  }
  return null;
}

/** The CLI command that gives a tenant its own template for `type` in `locale`. */
export function overrideCommand(tenant: string | null, type: string, locale: string): string {
  return `pnpm memento create-template --tenant ${tenant || "<tenant>"} --event-type ${type} --locale ${locale} --file ${type}.${locale}.hbs`;
}
