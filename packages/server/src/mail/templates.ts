import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LookupRegistry } from "@jsmemento/lookups";
import { TemplateEngine } from "../templates/engine.js";
import type { MailMessage } from "./mailer.js";

/** `packages/server/mail`: `<kind>.<locale>.hbs`, first line the subject, the rest the body. */
export const BUNDLED_MAIL_DIR = fileURLToPath(new URL("../../mail", import.meta.url));

export const MAIL_FALLBACK_LOCALE = "en";

/** What every mail template can use. */
export interface MailVariables {
  name: string;
  link: string;
  service_url: string;
}

const FILE_RE = /^([a-z_]+)\.([a-z]{2,8}(?:-[A-Za-z0-9]+)*)\.hbs$/;

/**
 * The mail templates, rendered with the event templates' sandboxed Handlebars engine.
 * `render(kind, locale, vars)` picks `<kind>.<locale>.hbs`, falling back to `en`.
 */
export class MailTemplates {
  private readonly bodies = new Map<string, string>();
  private readonly engine = new TemplateEngine({ registry: new LookupRegistry() });

  constructor(dir: string = BUNDLED_MAIL_DIR) {
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      if (FILE_RE.test(file))
        this.bodies.set(file.slice(0, -4), readFileSync(join(dir, file), "utf8"));
    }
    // Fail at startup, not on the first registration.
    for (const body of this.bodies.values()) this.engine.compile(body);
  }

  has(kind: string, locale = MAIL_FALLBACK_LOCALE): boolean {
    return this.bodies.has(`${kind}.${locale}`);
  }

  render(
    kind: string,
    locale: string,
    vars: MailVariables & Record<string, unknown>,
  ): Omit<MailMessage, "to"> {
    const chosen = this.bodies.has(`${kind}.${locale}`) ? locale : MAIL_FALLBACK_LOCALE;
    const body = this.bodies.get(`${kind}.${chosen}`);
    if (body === undefined) throw new Error(`no mail template "${kind}"`);
    const output = this.engine.compile(body)(JSON.parse(JSON.stringify(vars)), {
      data: { locale: chosen, locales: [chosen] },
      allowProtoMethodsByDefault: false,
      allowProtoPropertiesByDefault: false,
    });
    const newline = output.indexOf("\n");
    const subject = (newline < 0 ? output : output.slice(0, newline)).trim();
    const text = newline < 0 ? "" : output.slice(newline + 1).trim();
    return { subject, text: `${text}\n` };
  }
}
