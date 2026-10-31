import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FREE_TEXT_EVENT_TYPES, GENERIC_TEMPLATE } from "@memento/core";
import { LookupRegistry } from "@memento/lookups";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { templates } from "../db/schema.js";
import { type RenderContext, TemplateEngine } from "./engine.js";

/** The default templates shipped with the server: `templates/<EVENT_TYPE>.<locale>.hbs`. */
export const BUNDLED_TEMPLATES_DIR = fileURLToPath(new URL("../../templates", import.meta.url));

/** Used when not even a `_generic` template exists, or a template fails at render time. */
export const ULTIMATE_FALLBACK = "{{event_type}}: {{instance_type}}/{{instance_id}}";

const TEMPLATE_FILE_RE = /^([A-Z][A-Z0-9_]*|_generic)\.([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\.hbs$/;

/** Reads every `<EVENT_TYPE|_generic>.<locale>.hbs` of a directory, keyed `EVENT_TYPE.locale`. */
export function loadTemplateDir(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(dir).sort()) {
    const match = TEMPLATE_FILE_RE.exec(name);
    if (match) out.set(`${match[1]}.${match[2]}`, readFileSync(join(dir, name), "utf8").trim());
  }
  return out;
}

/**
 * The locales tried for `locale`, most specific first, ending with the default locale:
 * `sr-Latn-RS` → `sr-Latn-RS, sr-Latn, sr, en`.
 */
export function localeChain(locale: string, defaultLocale: string): string[] {
  const chain: string[] = [];
  for (const tag of [locale, defaultLocale]) {
    const parts = tag.split("-");
    for (let n = parts.length; n > 0; n--) {
      const candidate = parts.slice(0, n).join("-");
      if (!chain.includes(candidate)) chain.push(candidate);
    }
  }
  return chain;
}

/** The fields of an event a template sees. */
export interface RenderableEvent {
  id?: string;
  event_type: string;
  instance_type: string;
  instance_id: string;
  actor_id: string | null;
  occurred_at: string;
  payload: Record<string, unknown>;
}

export interface RenderResult {
  text: string;
  /** The locale that was asked for (stored as `rendered_locale`); `null` for verbatim text. */
  locale: string | null;
  /** Where the template came from. */
  source: "tenant" | "bundled" | "fallback" | "verbatim";
  /** `EVENT_TYPE.locale` of the template that was used. */
  template: string | null;
}

export interface EventRendererOptions {
  db: Database;
  /** Labels for the `label` helper. */
  registry?: LookupRegistry;
  /** Last step of every locale chain. Default `en`. */
  defaultLocale?: string;
  /** Default: the bundled templates. */
  bundled?: ReadonlyMap<string, string>;
  /** A template failed at render time (the fallback text is used instead). */
  onError?: (error: unknown, template: string) => void;
}

/**
 * Turns events into text. For each event the chain is
 * `EVENT_TYPE.<locale…>` then `_generic.<locale…>` (locales from `localeChain`), and at
 * every step the tenant's own template (`memento_template`) wins over the bundled one.
 */
export class EventRenderer {
  readonly engine: TemplateEngine;
  readonly defaultLocale: string;
  private readonly db: Database;
  private readonly bundled: ReadonlyMap<string, string>;
  private readonly onError: (error: unknown, template: string) => void;

  constructor(options: EventRendererOptions) {
    this.db = options.db;
    this.engine = new TemplateEngine({ registry: options.registry ?? new LookupRegistry() });
    this.defaultLocale = options.defaultLocale ?? "en";
    this.bundled = options.bundled ?? loadTemplateDir(BUNDLED_TEMPLATES_DIR);
    this.onError = options.onError ?? (() => {});
  }

  /** Renders one event of a tenant. */
  async render(tenantId: string, event: RenderableEvent, locale?: string): Promise<RenderResult> {
    const [result] = await this.renderMany(tenantId, [event], locale);
    return result as RenderResult;
  }

  /** Renders a page of events with one query for the tenant's templates. */
  async renderMany(
    tenantId: string,
    events: readonly RenderableEvent[],
    locale: string = this.defaultLocale,
  ): Promise<RenderResult[]> {
    const templated = events.filter((e) => !FREE_TEXT_EVENT_TYPES.includes(e.event_type));
    const overrides = await this.tenantTemplates(tenantId, [
      ...new Set(templated.map((event) => event.event_type)),
    ]);
    const chain = localeChain(locale, this.defaultLocale);
    return events.map((event) => this.renderOne(event, chain, overrides));
  }

  private async tenantTemplates(
    tenantId: string,
    eventTypes: string[],
  ): Promise<Map<string, string>> {
    if (eventTypes.length === 0) return new Map();
    const rows = await this.db
      .select({ eventType: templates.eventType, locale: templates.locale, body: templates.body })
      .from(templates)
      .where(
        and(
          eq(templates.tenantId, tenantId),
          inArray(templates.eventType, [...eventTypes, GENERIC_TEMPLATE]),
        ),
      );
    return new Map(rows.map((row) => [`${row.eventType}.${row.locale}`, row.body]));
  }

  private renderOne(
    event: RenderableEvent,
    chain: readonly string[],
    overrides: ReadonlyMap<string, string>,
  ): RenderResult {
    if (FREE_TEXT_EVENT_TYPES.includes(event.event_type)) {
      const text = event.payload.text;
      return {
        text: typeof text === "string" ? text : "",
        locale: null,
        source: "verbatim",
        template: null,
      };
    }
    const context: RenderContext = {
      event: { ...event },
      payload: event.payload,
      event_type: event.event_type,
      instance_type: event.instance_type,
      instance_id: event.instance_id,
      actor_id: event.actor_id,
      occurred_at: event.occurred_at,
    };
    const locale = chain[0] as string;
    for (const name of [event.event_type, GENERIC_TEMPLATE]) {
      for (const candidate of chain) {
        const key = `${name}.${candidate}`;
        const own = overrides.get(key);
        const body = own ?? this.bundled.get(key);
        if (body === undefined) continue;
        try {
          const text = this.engine.render(body, context, chain);
          return { text, locale, source: own === undefined ? "bundled" : "tenant", template: key };
        } catch (error) {
          this.onError(error, key);
          return this.fallback(context, chain);
        }
      }
    }
    return this.fallback(context, chain);
  }

  private fallback(context: RenderContext, chain: readonly string[]): RenderResult {
    const text = this.engine.render(ULTIMATE_FALLBACK, context, chain);
    return { text, locale: chain[0] as string, source: "fallback", template: null };
  }
}
