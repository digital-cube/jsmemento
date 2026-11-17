import { asc, type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/index.js";
import { type DatabaseHandle, dialect } from "../src/db/index.js";
import { listTemplates, saveTemplate } from "../src/services/templates.js";
import { createTenant, listTenants } from "../src/services/tenants.js";
import { type SqlField, SqlFilterCompiler } from "../src/udc/source.js";
import { onSqlite, reset, testDatabase } from "./helpers.js";

/**
 * Every ORDER BY over text is in code-point order on every database, whatever its collation
 * (TCKR2CRPDY: `listTemplates` came back `_generic` first on CI's `postgres:18`, whose default
 * collation `en_US.utf8` ignores punctuation at the first level). The words below sort
 * differently bytewise and linguistically — underscore against a letter, upper against lower
 * case, a dash inside a word — and the tests force a linguistic collation on the column, so they
 * fail without `dialect.bytewise` even on a `C`-collated database.
 */

/** Code-point order of WORDS. */
const WORDS = ["_generic", "USER_LOGIN", "USERS", "abc", "Abc", "Zed", "a-c", "ab"];
const BYTEWISE = ["Abc", "USERS", "USER_LOGIN", "Zed", "_generic", "a-c", "ab", "abc"];

/**
 * A collation that is not code-point order. PostgreSQL: ICU's root locale with punctuation
 * shifted to the last level — what glibc's `en_US.utf8` does, but on any ICU build (the
 * `postgres` images); created for this file and dropped after it (`und-x-icu` itself keeps
 * punctuation significant and would order the tenant slugs below bytewise). SQLite, which has no
 * linguistic collation: NOCASE.
 */
const LINGUISTIC = onSqlite ? "nocase" : "memento_test_linguistic";

/** WORDS as a table `v(x)` (a UNION: SQLite names no columns of a VALUES list). */
const words = sql.join(
  WORDS.map((w) => sql`select ${w} as x`),
  sql` union all `,
);
const x = sql`(x collate ${sql.raw(LINGUISTIC)})`;

async function ordered(handle: DatabaseHandle, order: SQL[]): Promise<string[]> {
  const result = (await handle.db.execute(
    sql`select x from (${words}) as v order by ${sql.join(order, sql`, `)}`,
  )) as unknown as { rows: Record<string, string>[] };
  return result.rows.map((r) => Object.values(r)[0] as string);
}

let handle: DatabaseHandle;
beforeAll(async () => {
  handle = testDatabase();
  if (!onSqlite) {
    await handle.db.execute(
      sql.raw(
        `create collation if not exists ${LINGUISTIC} (provider = icu, locale = 'und-u-ka-shifted')`,
      ),
    );
  }
});
afterAll(async () => {
  if (!onSqlite) await handle.db.execute(sql.raw(`drop collation if exists ${LINGUISTIC}`));
  await handle.close();
});

describe("dialect.bytewise", () => {
  it("orders in code-point order over a linguistic collation", async () => {
    // The premise: the forced collation really orders these words differently.
    expect(await ordered(handle, [sql`${x} asc`, sql`x asc`])).not.toEqual(BYTEWISE);
    expect(await ordered(handle, [asc(dialect.bytewise(x))])).toEqual(BYTEWISE);
  });

  it("is what a UDC sort on a text field compares", async () => {
    const field = (kind: SqlField["kind"]): SqlField => ({
      def: { type: "string" } as SqlField["def"],
      kind,
      expr: x,
    });
    const compiler = new SqlFilterCompiler({ word: field("text") });
    expect(
      await ordered(
        handle,
        compiler.orderBy([{ field: "word", dir: "asc" }], () => []),
      ),
    ).toEqual(BYTEWISE);
    expect(
      await ordered(
        handle,
        compiler.orderBy([{ field: "word", dir: "desc" }], () => []),
      ),
    ).toEqual([...BYTEWISE].reverse());
  });
});

/**
 * Runs `body` in a transaction rolled back afterwards. On PostgreSQL the transaction first
 * gives `columns` of `table` the linguistic collation, which no ORDER BY may depend on.
 */
async function withLinguisticColumns(
  table: string,
  columns: Record<string, string>,
  body: (db: Database) => Promise<void>,
): Promise<void> {
  const rollback = new Error("rollback");
  try {
    await handle.db.transaction(async (tx) => {
      if (!onSqlite) {
        const alters = Object.entries(columns).map(
          ([column, type]) => `alter column "${column}" type ${type} collate ${LINGUISTIC}`,
        );
        await tx.execute(sql.raw(`alter table "${table}" ${alters.join(", ")}`));
      }
      await body(tx as unknown as Database);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

describe("lists of the services", () => {
  beforeEach(async () => {
    await reset(handle);
    await createTenant(handle.db, { slug: "acme", name: "Acme" });
  });

  it("listTemplates: by event type then locale, in code-point order", async () => {
    for (const [event_type, locale] of [
      ["_generic", "sr"],
      ["USER_LOGIN", "sr-cyrl"],
      ["USER_LOGIN", "sr-Latn"],
      ["USERS", "en"],
      ["USER_LOGIN", "en"],
    ] as const) {
      await saveTemplate(handle.db, "acme", { event_type, locale, body: "x" });
    }
    await withLinguisticColumns(
      "memento_template",
      { event_type: "varchar(100)", locale: "varchar(35)" },
      async (db) => {
        expect((await listTemplates(db, "acme")).map((t) => `${t.event_type}.${t.locale}`)).toEqual(
          ["USERS.en", "USER_LOGIN.en", "USER_LOGIN.sr-Latn", "USER_LOGIN.sr-cyrl", "_generic.sr"],
        );
      },
    );
  });

  it("listTenants: by slug, in code-point order", async () => {
    for (const slug of ["ab", "a-c", "a1"]) await createTenant(handle.db, { slug, name: slug });
    await withLinguisticColumns("memento_tenant", { slug: "varchar(63)" }, async (db) => {
      expect((await listTenants(db)).map((t) => t.slug)).toEqual(["a-c", "a1", "ab", "acme"]);
    });
  });
});
