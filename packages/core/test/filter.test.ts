import { describe, expect, it } from "vitest";
import {
  and,
  decodeCursor,
  EventQuerySchema,
  encodeCursor,
  eventQueryToFilter,
  FilterSchema,
  matchCondition,
} from "../src/index.js";

describe("filter DSL", () => {
  it("accepts nested boolean trees", () => {
    const filter = {
      and: [
        { field: "instance_type", op: "eq", value: "chat" },
        {
          or: [
            { field: "event_type", op: "prefix", value: "CHAT_" },
            { not: { field: "actor_id", op: "is_null", value: true } },
          ],
        },
        {
          field: "occurred_at",
          op: "between",
          value: ["2026-01-01T00:00:00Z", "2026-12-31T00:00:00Z"],
        },
        { field: "instance_id", op: "in", value: ["1", "2"] },
      ],
    };
    expect(FilterSchema.parse(filter)).toEqual(filter);
  });

  it.each([
    { field: "payload", op: "eq", value: "x" },
    { field: "event_type", op: "in", value: "x" },
    { field: "event_type", op: "in", value: [] },
    { field: "event_type", op: "between", value: ["a"] },
    { field: "event_type", op: "regex", value: "x" },
    { and: [] },
  ])("rejects %j", (filter) => {
    expect(FilterSchema.safeParse(filter).success).toBe(false);
  });

  it("turns wildcards into prefix conditions", () => {
    expect(matchCondition("event_type", "CHAT_*")).toEqual({
      field: "event_type",
      op: "prefix",
      value: "CHAT_",
    });
    expect(matchCondition("instance_id", "42")).toEqual({
      field: "instance_id",
      op: "eq",
      value: "42",
    });
    expect(matchCondition("instance_id", "*")).toBeNull();
  });

  it("and() drops empty parts", () => {
    const c = { field: "event_type", op: "eq", value: "A" } as const;
    expect(and(null, undefined)).toBeNull();
    expect(and(c, null)).toEqual(c);
    expect(and(c, c)).toEqual({ and: [c, c] });
  });
});

describe("event query", () => {
  it("applies defaults and coercion", () => {
    expect(EventQuerySchema.parse({})).toEqual({
      limit: 50,
      order: "desc",
      include_archived: false,
    });
    const q = EventQuerySchema.parse({ limit: "10", include_archived: "1", order: "asc" });
    expect(q).toMatchObject({ limit: 10, include_archived: true, order: "asc" });
    expect(EventQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(EventQuerySchema.safeParse({ limit: "501" }).success).toBe(false);
  });

  it("maps query params to a filter", () => {
    const q = EventQuerySchema.parse({
      instance_type: "user",
      instance_id: "42",
      event_type: "USER_*",
      actor_id: "igor",
      after: "2026-10-01T00:00:00Z",
      before: "2026-11-01T00:00:00Z",
    });
    expect(eventQueryToFilter(q)).toEqual({
      and: [
        { field: "event_type", op: "prefix", value: "USER_" },
        { field: "instance_type", op: "eq", value: "user" },
        { field: "instance_id", op: "eq", value: "42" },
        { field: "actor_id", op: "eq", value: "igor" },
        { field: "occurred_at", op: "gte", value: "2026-10-01T00:00:00Z" },
        { field: "occurred_at", op: "lt", value: "2026-11-01T00:00:00Z" },
      ],
    });
    expect(eventQueryToFilter(EventQuerySchema.parse({}))).toBeNull();
  });

  it("round-trips cursors and rejects garbage", () => {
    const cursor = {
      occurred_at: "2026-10-30T10:00:00.123Z",
      id: "0b9f3a2e-6f4c-4f63-9b1a-3f2a1c0d9e8b",
    };
    const token = encodeCursor(cursor);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(token)).toEqual(cursor);
    expect(decodeCursor("%%%")).toBeNull();
    expect(decodeCursor(btoa(JSON.stringify(["x", "y"])))).toBeNull();
  });
});
