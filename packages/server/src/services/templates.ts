import {
  LocaleSchema,
  type Template,
  TemplateEventTypeSchema,
  type TemplateInput,
  TemplateInputSchema,
} from "@memento/core";
import { LookupRegistry } from "@memento/lookups";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { templates } from "../db/schema.js";
import { MementoError } from "../errors.js";
import { TemplateEngine, TemplateSyntaxError } from "../templates/engine.js";
import { isUniqueViolation } from "./pg.js";
import { getTenantBySlug } from "./tenants.js";

type TemplateRow = typeof templates.$inferSelect;

export function serializeTemplate(row: TemplateRow): Template {
  return {
    id: row.id,
    event_type: row.eventType,
    locale: row.locale,
    body: row.body,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

let checker: TemplateEngine | undefined;

/** Throws `validation_error` when `body` does not compile in the sandbox. */
export function checkTemplateBody(body: string): void {
  checker ??= new TemplateEngine({ registry: new LookupRegistry(), cacheSize: 1 });
  try {
    checker.compile(body);
  } catch (error) {
    if (error instanceof TemplateSyntaxError) {
      throw new MementoError("validation_error", `invalid template: ${error.message}`);
    }
    throw error;
  }
}

export interface SaveTemplateOptions {
  /** Overwrite an existing template for the same event type and locale. */
  replace?: boolean;
}

/**
 * Creates a tenant's template for an event type (or `_generic`) in a locale. The body is
 * compiled first, so a broken template never reaches the renderer.
 */
export async function saveTemplate(
  db: Database,
  tenantSlug: string,
  input: TemplateInput,
  options: SaveTemplateOptions = {},
): Promise<{ template: Template; created: boolean }> {
  const parsed = TemplateInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new MementoError("validation_error", "invalid template", parsed.error.issues);
  }
  const data = parsed.data;
  checkTemplateBody(data.body);
  const tenant = await getTenantBySlug(db, tenantSlug);
  const values = {
    tenantId: tenant.id,
    eventType: data.event_type,
    locale: data.locale,
    body: data.body,
  };
  try {
    const [row] = await db.insert(templates).values(values).returning();
    return { template: serializeTemplate(row as TemplateRow), created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    if (!options.replace) {
      throw new MementoError(
        "conflict",
        `template ${data.event_type}/${data.locale} already exists for "${tenantSlug}" (use replace)`,
      );
    }
  }
  const [row] = await db
    .update(templates)
    .set({ body: data.body, updatedAt: new Date() })
    .where(
      and(
        eq(templates.tenantId, tenant.id),
        eq(templates.eventType, data.event_type),
        eq(templates.locale, data.locale),
      ),
    )
    .returning();
  return { template: serializeTemplate(row as TemplateRow), created: false };
}

/** A tenant's templates, by event type then locale. */
export async function listTemplates(db: Database, tenantSlug: string): Promise<Template[]> {
  const tenant = await getTenantBySlug(db, tenantSlug);
  const rows = await db
    .select()
    .from(templates)
    .where(eq(templates.tenantId, tenant.id))
    .orderBy(asc(templates.eventType), asc(templates.locale));
  return rows.map(serializeTemplate);
}

/** Removes a tenant's template; rendering falls back to the bundled one. */
export async function deleteTemplate(
  db: Database,
  tenantSlug: string,
  eventType: string,
  locale: string,
): Promise<Template> {
  TemplateEventTypeSchema.parse(eventType);
  LocaleSchema.parse(locale);
  const tenant = await getTenantBySlug(db, tenantSlug);
  const [row] = await db
    .delete(templates)
    .where(
      and(
        eq(templates.tenantId, tenant.id),
        eq(templates.eventType, eventType),
        eq(templates.locale, locale),
      ),
    )
    .returning();
  if (!row) {
    throw new MementoError(
      "not_found",
      `template ${eventType}/${locale} not found for "${tenantSlug}"`,
    );
  }
  return serializeTemplate(row);
}
