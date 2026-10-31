import type { Chat, ChatMessageResult, MementoEvent } from "@memento/core";
import { beforeAll, describe, expect, it } from "vitest";
import { api, LiveFeed, newTenant, type TenantKeys } from "./helpers.js";

let acme: TenantKeys;
beforeAll(async () => {
  acme = await newTenant("chats");
});

describe("chat: create → send → see it live", () => {
  it("streams messages and read receipts of one chat to its subscribers", async () => {
    const created = await api<Chat>(acme.write, "POST", "/chats", {
      participants: ["igor", "marko"],
      name: "Igor-Marko chat",
    });
    expect(created.status).toBe(201);
    const chat = created.body.data;
    expect(chat.kind).toBe("direct");

    // a client following this chat, and one following a different chat
    const live = await LiveFeed.open(acme.read, {
      instance_type: "chat",
      instance_id: chat.chat_id,
    });
    const other = await LiveFeed.open(acme.read, {
      instance_type: "chat",
      instance_id: "chat-somewhere-else",
    });

    const sent = await api<ChatMessageResult>(
      acme.write,
      "POST",
      `/chats/${chat.chat_id}/messages`,
      { user_id: "igor", content: "Zdravo Marko!" },
    );
    expect(sent.status).toBe(201);
    const message = sent.body.data;

    const streamed = await live.next();
    expect(streamed).toMatchObject({
      id: message.event_id,
      event_type: "CHAT_MESSAGE_SENT",
      instance_id: chat.chat_id,
      actor_id: "igor",
    });
    expect(streamed.payload).toMatchObject({ content: "Zdravo Marko!", sender_user_id: "igor" });

    // marko reads it: the read receipt is an event of the same chat
    const seen = await api<{ advanced: boolean }>(
      acme.write,
      "POST",
      `/chats/${chat.chat_id}/seen`,
      {
        user_id: "marko",
        up_to_event_id: message.event_id,
      },
    );
    expect(seen.status).toBe(200);
    expect(seen.body.data.advanced).toBe(true);
    const receipt = await live.next();
    expect(receipt).toMatchObject({ event_type: "CHAT_MESSAGE_SEEN", actor_id: "marko" });

    // history agrees with what was streamed
    const history = await api<MementoEvent[]>(
      acme.read,
      "GET",
      `/chats/${chat.chat_id}/messages?user_id=marko`,
    );
    expect(history.body.data.map((e) => e.id)).toEqual([message.event_id]);
    const state = await api<Chat>(acme.read, "GET", `/chats/${chat.chat_id}?user_id=marko`);
    const marko = state.body.data.participants.find((p) => p.user_id === "marko");
    expect(marko?.last_seen_event_id).toBe(message.event_id);

    expect(other.events).toEqual([]);
  });

  it("refuses reading a chat to a non-participant", async () => {
    const created = await api<Chat>(acme.write, "POST", "/chats", {
      participants: ["ana", "petar"],
    });
    const chat = created.body.data;
    const read = await api(acme.read, "GET", `/chats/${chat.chat_id}/messages?user_id=igor`);
    expect(read.status).toBe(403);
  });
});
