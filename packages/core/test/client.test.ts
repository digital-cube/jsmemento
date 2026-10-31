import { describe, expect, it, vi } from "vitest";
import { MementoApiError, MementoClient } from "../src/index.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function client(response: Response | Error) {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    if (response instanceof Error) throw response;
    return response;
  });
  return {
    fetch,
    client: new MementoClient({ baseUrl: "http://h/memento/", apiKey: "mk_k", fetch }),
  };
}

describe("MementoClient", () => {
  it("lists events with the query string and the bearer key", async () => {
    const meta = { limit: 50, count: 0, next_cursor: null };
    const { fetch, client: c } = client(json(200, { ok: true, data: [], meta }));
    const page = await c.listEvents({ event_type: "CHAT_*", instance_id: "", limit: 50 });
    expect(page).toEqual({ data: [], meta });
    expect(fetch).toHaveBeenCalledWith("http://h/memento/events?event_type=CHAT_*&limit=50", {
      method: "GET",
      headers: { authorization: "Bearer mk_k" },
    });
  });

  it("reads and sends chat messages", async () => {
    const reading = client(
      json(200, { ok: true, data: [], meta: { limit: 100, count: 0, next_cursor: null } }),
    );
    await reading.client.chatMessages("123", { user_id: "igor", limit: 100 });
    expect(reading.fetch.mock.calls[0]?.[0]).toBe(
      "http://h/memento/chats/chat-123/messages?order=asc&user_id=igor&limit=100",
    );

    const sending = client(json(201, { ok: true, data: { event_id: "e1" } }));
    expect(
      await sending.client.sendMessage(
        "chat-1",
        { user_id: "igor", content: "hi" },
        { locale: "sr" },
      ),
    ).toEqual({
      event_id: "e1",
    });
    expect(sending.fetch).toHaveBeenCalledWith("http://h/memento/chats/chat-1/messages?locale=sr", {
      method: "POST",
      headers: { authorization: "Bearer mk_k", "content-type": "application/json" },
      body: JSON.stringify({ user_id: "igor", content: "hi" }),
    });

    const chat = client(json(200, { ok: true, data: { chat_id: "chat-1" } }));
    expect(await chat.client.getChat("1", { user_id: "igor" })).toEqual({ chat_id: "chat-1" });
    expect(chat.fetch.mock.calls[0]?.[0]).toBe("http://h/memento/chats/chat-1?user_id=igor");
  });

  it("turns error envelopes into MementoApiError", async () => {
    const { client: c } = client(
      json(403, {
        ok: false,
        error: { code: "forbidden", message: "not a participant", details: [1] },
        request_id: "r1",
      }),
    );
    const error = await c.listEvents().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MementoApiError);
    expect(error).toMatchObject({
      status: 403,
      code: "forbidden",
      message: "not a participant",
      details: [1],
      requestId: "r1",
    });
  });

  it("reports a body that is not an envelope, and a network failure", async () => {
    const proxy = client(new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(proxy.client.listEvents()).rejects.toMatchObject({
      status: 502,
      code: "bad_response",
      message: "HTTP 502",
    });
    const down = client(new TypeError("fetch failed"));
    await expect(down.client.listEvents()).rejects.toMatchObject({
      status: 0,
      code: "network_error",
      message: "cannot reach http://h/memento: fetch failed",
    });
  });

  it("uses the global fetch by default and fills in missing meta", async () => {
    const fetch = vi.fn(async () => json(200, { ok: true, data: { chat_id: "chat-1" } }));
    vi.stubGlobal("fetch", fetch);
    try {
      const c = new MementoClient({ baseUrl: "http://h/memento", apiKey: "k" });
      expect(await c.chatMessages("1")).toEqual({
        data: { chat_id: "chat-1" },
        meta: { limit: 0, count: 0, next_cursor: null },
      });
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
