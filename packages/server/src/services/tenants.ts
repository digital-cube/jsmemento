import { type Tenant, type TenantCreate, TenantCreateSchema } from "@jsmemento/core";
import { asc, eq } from "drizzle-orm";
import { type Database, dialect } from "../db/index.js";
import { type TenantRow, tenants } from "../db/schema.js";
import { MementoError } from "../errors.js";

export function serializeTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    is_active: row.isActive,
    created_at: row.createdAt.toISOString(),
  };
}

export async function createTenant(db: Database, input: TenantCreate): Promise<Tenant> {
  const data = TenantCreateSchema.parse(input);
  try {
    const [row] = await db.insert(tenants).values(data).returning();
    return serializeTenant(row as TenantRow);
  } catch (error) {
    if (dialect.isUniqueViolation(error)) {
      throw new MementoError("conflict", `tenant "${data.slug}" already exists`);
    }
    throw error;
  }
}

export async function getTenantBySlug(db: Database, slug: string): Promise<Tenant> {
  const row = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (!row) throw new MementoError("not_found", `tenant "${slug}" not found`);
  return serializeTenant(row);
}

/** Every tenant, by slug in code-point order (`dialect.bytewise`) on every database. */
export async function listTenants(db: Database): Promise<Tenant[]> {
  const rows = await db
    .select()
    .from(tenants)
    .orderBy(asc(dialect.bytewise(tenants.slug)));
  return rows.map(serializeTenant);
}
