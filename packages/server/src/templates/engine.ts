import type { LookupRegistry } from "@memento/lookups";
import Handlebars from "handlebars";

/** A template body that does not compile, or uses something the sandbox forbids. */
export class TemplateSyntaxError extends Error {
  override name = "TemplateSyntaxError";
}

/** Data available to a template. Plain JSON only: the sandbox never calls functions. */
export interface RenderContext {
  event: Record<string, unknown>;
  payload: Record<string, unknown>;
  event_type: string;
  instance_type: string;
  instance_id: string;
  actor_id: string | null;
  occurred_at: string;
}

/** Rendered text is capped like the `rendered` column the producers may fill. */
export const RENDERED_MAX = 10_000;

type HelperOptions = Handlebars.HelperOptions & {
  data?: { locale?: string; locales?: readonly string[] };
};

const isEmpty = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);

/** The helper arguments without Handlebars' trailing `options` object. */
const args = (values: unknown[]) => values.slice(0, -1);
const options = (values: unknown[]) => values.at(-1) as HelperOptions;
const localeOf = (opts: HelperOptions) => opts.data?.locale ?? "en";
const text = (value: unknown) => (value === undefined || value === null ? "" : String(value));

function helpers(registry: LookupRegistry): Record<string, Handlebars.HelperDelegate> {
  return {
    /** First argument that is not empty: `{{default actor_id instance_id}}`. */
    default: (...values: unknown[]) => args(values).find((value) => !isEmpty(value)) ?? "",
    eq: (a: unknown, b: unknown) => a === b,
    ne: (a: unknown, b: unknown) => a !== b,
    and: (...values: unknown[]) =>
      args(values).every((value) => !isEmpty(value) && value !== false),
    or: (...values: unknown[]) => args(values).some((value) => !isEmpty(value) && value !== false),
    not: (value: unknown) => isEmpty(value) || value === false,
    upper: (value: unknown) => text(value).toLocaleUpperCase(),
    lower: (value: unknown) => text(value).toLocaleLowerCase(),
    capitalize: (value: unknown) => {
      const s = text(value);
      return s.charAt(0).toLocaleUpperCase() + s.slice(1);
    },
    /** `{{truncate payload.content 80}}` — cuts at N characters and appends `…`. */
    truncate: (value: unknown, length: unknown) => {
      const s = text(value);
      const n = Number.isInteger(length) ? (length as number) : 100;
      return s.length > n ? `${s.slice(0, Math.max(n, 0)).trimEnd()}…` : s;
    },
    /** Joins a list, or the keys of an object (`changes: { title: …, status: … }`). */
    join: (value: unknown, separator: unknown) => {
      const sep = typeof separator === "string" ? separator : ", ";
      if (Array.isArray(value)) return value.map(text).join(sep);
      if (value && typeof value === "object") return Object.keys(value).join(sep);
      return text(value);
    },
    json: (value: unknown) => JSON.stringify(value ?? null),
    /** `{{date occurred_at}}`, `{{date payload.due "long" timeZone="Europe/Belgrade"}}`. */
    date: (...values: unknown[]) => {
      const [value, style] = args(values);
      const opts = options(values);
      const date = new Date(text(value));
      if (Number.isNaN(date.getTime())) return text(value);
      const dateStyle = (["full", "long", "medium", "short"] as const).find((s) => s === style);
      const timeZone = typeof opts.hash.timeZone === "string" ? opts.hash.timeZone : "UTC";
      try {
        return new Intl.DateTimeFormat(localeOf(opts), {
          dateStyle: dateStyle ?? "medium",
          timeStyle: "short",
          timeZone,
        }).format(date);
      } catch {
        return date.toISOString();
      }
    },
    number: (value: unknown, ...rest: unknown[]) => {
      const n = Number(value);
      return Number.isFinite(n)
        ? new Intl.NumberFormat(localeOf(options(rest))).format(n)
        : text(value);
    },
    /**
     * `{{plural payload.count one="# poruka" few="# poruke" other="# poruka"}}` — picks the
     * form by the locale's plural rules; `#` is replaced by the number.
     */
    plural: (count: unknown, opts: HelperOptions) => {
      const n = Number(count);
      if (!Number.isFinite(n)) return "";
      const category = new Intl.PluralRules(localeOf(opts)).select(n);
      const form = opts.hash[category] ?? opts.hash.other ?? "";
      return text(form).replaceAll("#", new Intl.NumberFormat(localeOf(opts)).format(n));
    },
    /** `{{label "EventTypes" event_type}}` — the translated label of a lookup term. */
    label: (section: unknown, value: unknown, opts: HelperOptions) => {
      const raw = text(value);
      const locales = opts.data?.locales ?? [localeOf(opts)];
      return registry.label(text(section), raw, locales) ?? raw;
    },
  };
}

const FORBIDDEN_NODES: Record<string, string> = {
  PartialStatement: "partials",
  PartialBlockStatement: "partials",
  Decorator: "decorators",
  DecoratorBlock: "decorators",
};

/** Rejects partials and decorators, which reach outside the template. */
function checkAst(node: unknown): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) checkAst(child);
    return;
  }
  const type = (node as { type?: unknown }).type;
  if (typeof type === "string" && type in FORBIDDEN_NODES) {
    throw new TemplateSyntaxError(`templates may not use ${FORBIDDEN_NODES[type]}`);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== "loc") checkAst(value);
  }
}

export interface TemplateEngineOptions {
  registry: LookupRegistry;
  /** Compiled templates kept in memory (by body). Default 500. */
  cacheSize?: number;
}

/**
 * Sandboxed Handlebars: an isolated environment with only memento's helpers, no partials
 * or decorators, no prototype access, JSON-only data, plain-text output (no HTML escaping —
 * consumers that put `rendered` into HTML must escape it).
 */
export class TemplateEngine {
  private readonly hb: typeof Handlebars;
  private readonly compileOptions: CompileOptions;
  private readonly cache = new Map<string, Handlebars.TemplateDelegate>();
  private readonly cacheSize: number;

  constructor(options: TemplateEngineOptions) {
    this.hb = Handlebars.create();
    this.hb.unregisterHelper("log");
    const own = helpers(options.registry);
    for (const [name, fn] of Object.entries(own)) this.hb.registerHelper(name, fn);
    this.compileOptions = {
      noEscape: true,
      strict: false,
      knownHelpersOnly: true,
      knownHelpers: {
        ...Object.fromEntries(Object.keys(own).map((name) => [name, true])),
        log: false,
        helperMissing: false,
        blockHelperMissing: false,
      },
    };
    this.cacheSize = options.cacheSize ?? 500;
  }

  /** Compiles (and caches) a body; throws `TemplateSyntaxError` when it is not allowed. */
  compile(body: string): Handlebars.TemplateDelegate {
    const cached = this.cache.get(body);
    if (cached) return cached;
    let template: Handlebars.TemplateDelegate;
    try {
      const ast = this.hb.parse(body);
      checkAst(ast);
      // `compile` is lazy: precompiling surfaces unknown helpers here, not at render time.
      this.hb.precompile(ast, this.compileOptions);
      template = this.hb.compile(ast, this.compileOptions);
    } catch (error) {
      if (error instanceof TemplateSyntaxError) throw error;
      throw new TemplateSyntaxError((error as Error).message.split("\n")[0] as string);
    }
    if (this.cache.size >= this.cacheSize) {
      this.cache.delete(this.cache.keys().next().value as string);
    }
    this.cache.set(body, template);
    return template;
  }

  /**
   * Renders `body` against `context` in `locales[0]` (`locales` is the fallback chain the
   * `label` helper walks). Throws on a syntax or runtime error.
   */
  render(body: string, context: RenderContext, locales: readonly string[]): string {
    const template = this.compile(body);
    const data = JSON.parse(JSON.stringify(context)) as RenderContext;
    const output = template(data, {
      data: { locale: locales[0] ?? "en", locales },
      allowProtoMethodsByDefault: false,
      allowProtoPropertiesByDefault: false,
    });
    const trimmed = output.trim();
    return trimmed.length > RENDERED_MAX ? `${trimmed.slice(0, RENDERED_MAX - 1)}…` : trimmed;
  }
}
