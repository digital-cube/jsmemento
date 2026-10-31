import { describe, expect, it } from "vitest";
import {
  extractApiKey,
  generateApiKey,
  hashApiKey,
  hasScope,
  parseApiKey,
  parseScopes,
  timingSafeEqual,
} from "../src/index.js";

describe("api keys", () => {
  it("generates well-formed, unique keys whose prefix is embedded", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).toMatch(/^mk_[a-z0-9]{8}_[A-Za-z0-9]{32}$/);
    expect(a.key.startsWith(`mk_${a.prefix}_`)).toBe(true);
    expect(a.key).not.toBe(b.key);
    expect(parseApiKey(a.key)).toEqual({ prefix: a.prefix, secret: a.key.slice(12) });
  });

  it("rejects malformed keys", () => {
    for (const bad of [
      "",
      "mk_short_x",
      `xx_abcdefgh_${"a".repeat(32)}`,
      `mk_ABCDEFGH_${"a".repeat(32)}`,
    ]) {
      expect(parseApiKey(bad)).toBeNull();
    }
  });

  it("hashes deterministically to sha-256 hex", async () => {
    expect(await hashApiKey("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const { key } = generateApiKey();
    expect(await hashApiKey(key)).toBe(await hashApiKey(key));
  });

  it("compares in constant time", () => {
    expect(timingSafeEqual("abcd", "abcd")).toBe(true);
    expect(timingSafeEqual("abcd", "abce")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });

  it("extracts the key from Authorization or X-Api-Key", () => {
    expect(extractApiKey({ authorization: "Bearer mk_x" })).toBe("mk_x");
    expect(extractApiKey({ authorization: "bearer   mk_y " })).toBe("mk_y");
    expect(extractApiKey({ "x-api-key": " mk_z " })).toBe("mk_z");
    expect(extractApiKey({ "x-api-key": ["mk_a", "mk_b"] })).toBe("mk_a");
    expect(extractApiKey({ authorization: "Basic abc" })).toBeNull();
    expect(extractApiKey({ "x-api-key": "  " })).toBeNull();
    expect(extractApiKey({})).toBeNull();
  });
});

describe("scopes", () => {
  it("admin implies everything, others are exact", () => {
    expect(hasScope(["admin"], "write")).toBe(true);
    expect(hasScope(["read"], "read")).toBe(true);
    expect(hasScope(["read"], "write")).toBe(false);
    expect(hasScope(["write"], "read")).toBe(false);
    expect(hasScope([], "read")).toBe(false);
  });

  it("parses scope lists into canonical order", () => {
    expect(parseScopes("write, read,read")).toEqual(["read", "write"]);
    expect(parseScopes(["admin"])).toEqual(["admin"]);
    expect(() => parseScopes(" , ")).toThrow(/at least one/);
    expect(() => parseScopes("read,root")).toThrow(/unknown scope\(s\): root/);
  });
});
