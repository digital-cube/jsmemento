import { describe, expect, it } from "vitest";
import {
  ApiKeyCreateSchema,
  buildDescribe,
  ChatSchema,
  DEFAULT_EVENT_VIEW,
  ERROR_CODES,
  EventInputSchema,
  EventSchema,
  fail,
  ok,
  SeenSchema,
  StarSchema,
  successEnvelope,
  TemplateSchema,
  TenantCreateSchema,
  UserSchema,
  ViewConfigSchema,
} from "../src/index.js";

const uuid = "0b9f3a2e-6f4c-4f63-9b1a-3f2a1c0d9e8b";
const now = "2026-10-30T10:00:00Z";

describe("EventInputSchema", () => {
  it("accepts a minimal event and normalises ids to strings", () => {
    const parsed = EventInputSchema.parse({
      event_type: "USER_LOGIN",
      instance_type: "user",
      instance_id: 42,
      actor_id: 7,
    });
    expect(parsed).toEqual({
      event_type: "USER_LOGIN",
      instance_type: "user",
      instance_id: "42",
      actor_id: "7",
      payload: {},
    });
  });

  it("accepts payload, occurred_at with offset and rendered text", () => {
    const parsed = EventInputSchema.parse({
      event_type: "CHAT_MESSAGE_SENT",
      instance_type: "chat",
      instance_id: "igor-marko",
      payload: { content: "Pozdrav!" },
      occurred_at: "2026-10-30T10:00:00+02:00",
      rendered: "Igor sent a message",
    });
    expect(parsed.payload).toEqual({ content: "Pozdrav!" });
  });

  it.each([
    [{ event_type: "user_login", instance_type: "user", instance_id: "1" }, "event_type"],
    [{ event_type: "USER_LOGIN", instance_type: "User", instance_id: "1" }, "instance_type"],
    [{ event_type: "USER_LOGIN", instance_type: "user", instance_id: "  " }, "instance_id"],
    [{ event_type: "USER_LOGIN", instance_type: "user", instance_id: 1.5 }, "instance_id"],
    [{ event_type: "USER_LOGIN", instance_type: "user", instance_id: "1", payload: [] }, "payload"],
    [
      {
        event_type: "USER_LOGIN",
        instance_type: "user",
        instance_id: "1",
        occurred_at: "yesterday",
      },
      "occurred_at",
    ],
    [{ event_type: "USER_LOGIN", instance_type: "user", instance_id: "1", extra: true }, ""],
    [{ instance_type: "user", instance_id: "1" }, "event_type"],
  ])("rejects %j", (input, path) => {
    const result = EventInputSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain(path);
  });
});

describe("entity schemas", () => {
  it("parse valid documents", () => {
    expect(
      EventSchema.parse({
        id: uuid,
        occurred_at: now,
        received_at: now,
        event_type: "USER_LOGIN",
        instance_type: "user",
        instance_id: "42",
        actor_id: null,
        payload: {},
        rendered: null,
        rendered_locale: null,
        archived_at: null,
      }).id,
    ).toBe(uuid);
    expect(TenantCreateSchema.parse({ slug: "acme-co", name: " Acme " }).name).toBe("Acme");
    expect(TenantCreateSchema.safeParse({ slug: "Acme_Co", name: "x" }).success).toBe(false);
    expect(ApiKeyCreateSchema.parse({ name: "ci", scopes: ["read"] }).scopes).toEqual(["read"]);
    expect(UserSchema.parse({ id: 5, email: "a@b.rs" }).id).toBe("5");
    expect(SeenSchema.parse({ event_id: uuid, user_id: "u", seen_at: now }).user_id).toBe("u");
    expect(StarSchema.parse({ event_id: uuid, user_id: "u", starred_at: now }).note).toBeNull();
    expect(
      TemplateSchema.parse({
        id: uuid,
        event_type: "USER_LOGIN",
        locale: "sr-Latn",
        body: "{{ actor_id }} se prijavio",
        created_at: now,
        updated_at: now,
      }).locale,
    ).toBe("sr-Latn");
    expect(
      ChatSchema.parse({
        id: uuid,
        instance_id: "igor-marko",
        title: null,
        participants: ["igor", 7],
        created_at: now,
        archived_at: null,
      }).participants,
    ).toEqual(["igor", "7"]);
  });
});

describe("envelope", () => {
  it("builds success and error bodies", () => {
    expect(ok([1])).toEqual({ ok: true, data: [1] });
    const meta = { limit: 1, count: 1, next_cursor: null };
    expect(ok([1], meta)).toEqual({ ok: true, data: [1], meta });
    expect(fail("not_found", "nope")).toEqual({
      ok: false,
      error: { code: "not_found", message: "nope" },
    });
    expect(fail("validation_error", "bad", { details: [1], request_id: "r1" })).toEqual({
      ok: false,
      error: { code: "validation_error", message: "bad", details: [1] },
      request_id: "r1",
    });
    expect(ERROR_CODES.forbidden).toBe(403);
  });

  it("validates a success envelope against its data schema", () => {
    const schema = successEnvelope(EventSchema.pick({ id: true }));
    expect(schema.safeParse({ ok: true, data: { id: uuid } }).success).toBe(true);
    expect(schema.safeParse({ ok: true, data: { id: 1 } }).success).toBe(false);
  });
});

describe("view & describe", () => {
  it("default event view is a valid view config", () => {
    expect(ViewConfigSchema.parse(DEFAULT_EVENT_VIEW).collection).toBe("events");
  });

  it("describes capabilities and JSON schemas", () => {
    const describe = buildDescribe({ slug: "acme", name: "Acme" }, { realtime: true });
    expect(describe.capabilities).toMatchObject({ push: true, realtime: true, templates: true });
    expect(describe.schema.event_input).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["event_type", "instance_type", "instance_id"]),
    });
    expect(describe.filter.ops).toContain("between");
  });
});
