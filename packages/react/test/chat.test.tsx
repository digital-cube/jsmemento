import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Avatar,
  applyChatEvent,
  hue,
  initials,
  MementoChat,
  messageSender,
  messageText,
  seenMarkers,
} from "../src/index.js";
import { FakeSocket, fakeFetch, makeEvent, wrapper } from "./fixtures.js";

afterEach(() => {
  FakeSocket.all = [];
});

const message = (sender: string, content: string) =>
  makeEvent({
    event_type: "CHAT_MESSAGE_SENT",
    instance_type: "chat",
    instance_id: "chat-123",
    actor_id: sender,
    payload: { content, sender_user_id: sender, timestamp: "2026-10-30T10:00:00.000Z" },
    rendered: `${sender} sent a message: "${content}"`,
  });

const texts = () =>
  screen
    .getAllByRole("listitem")
    .map((item) => item.querySelector(".memento-message__text")?.textContent);

describe("MementoChat", () => {
  it("loads the chat as the user, oldest first, and subscribes to its messages", async () => {
    const hello = message("marko", "Zdravo Igore!");
    const reply = message("igor", "Pozdrav!");
    const fetch = fakeFetch(() => [reply, hello]);
    render(<MementoChat chatId="123" userId="igor" timeZone="UTC" />, {
      wrapper: wrapper(fetch, { locale: "sr" }),
    });
    expect(screen.getByText("Loading messages…")).toBeTruthy();
    await waitFor(() => expect(texts()).toEqual(["Zdravo Igore!", "Pozdrav!"]));
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "http://memento.test/memento/chats/chat-123/messages?order=desc&user_id=igor&limit=100&locale=sr",
    );
    expect(screen.getByRole("heading", { name: "chat-123" })).toBeTruthy();

    const own = screen.getByText("Pozdrav!").closest("li") as HTMLElement;
    expect(own.dataset.own).toBe("true");
    expect(screen.getByText("Zdravo Igore!").closest("li")?.dataset.own).toBeUndefined();
    expect(own.querySelector(".memento-avatar")?.textContent).toBe("IG");

    const socket = FakeSocket.last();
    expect(socket.query).toEqual({
      instance_type: "chat",
      instance_id: "chat-123",
      event_type: "CHAT_MESSAGE_SENT",
      locale: "sr",
    });
  });

  it("shows messages from the stream in real time", async () => {
    render(<MementoChat chatId="chat-123" userId="igor" />, {
      wrapper: wrapper(fakeFetch(() => [])),
    });
    await screen.findByText("No messages yet. Write the first one.");
    const socket = FakeSocket.last();
    act(() => socket.welcome());
    expect(screen.getByRole("status").textContent).toBe("Live");
    act(() => socket.push(message("marko", "Jesi tu?")));
    expect(texts()).toEqual(["Jesi tu?"]);
  });

  it("sends a message, shows it at once and merges the stream's copy", async () => {
    const sent = message("igor", "Evo me");
    const fetch = fakeFetch((url, init) => {
      if (init.method === "POST") {
        expect(url.pathname).toBe("/memento/chats/chat-123/messages");
        expect(JSON.parse(String(init.body))).toEqual({ user_id: "igor", content: "Evo me" });
        return { event_id: sent.id, message: sent, rendered: sent.rendered };
      }
      return [];
    });
    render(<MementoChat chatId="123" userId="igor" displayName={(id) => id.toUpperCase()} />, {
      wrapper: wrapper(fetch),
    });
    const input = screen.getByLabelText("Message") as HTMLInputElement;
    expect(input.placeholder).toBe("Message as IGOR");
    const button = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "  Evo me " } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() => expect(texts()).toEqual(["Evo me"]));
    expect(input.value).toBe("");
    expect(screen.getByText("IGOR")).toBeTruthy();
    act(() => FakeSocket.last().push(sent));
    expect(texts()).toEqual(["Evo me"]);
  });

  it("keeps the draft and shows the error when sending fails", async () => {
    const fetch = fakeFetch((_url, init) => {
      if (init.method === "POST") throw new Error("igor is not a participant");
      return [];
    });
    render(<MementoChat chatId="123" userId="igor" title="Sales" />, { wrapper: wrapper(fetch) });
    expect(screen.getByRole("heading", { name: "Sales" })).toBeTruthy();
    const input = screen.getByLabelText("Message") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toBe("igor is not a participant");
    expect(input.value).toBe("Hello");
    // An empty draft is not sent.
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("reports a failed load", async () => {
    render(<MementoChat chatId="123" userId="eve" />, {
      wrapper: wrapper(fakeFetch(() => Promise.reject(new Error("eve is not a participant")))),
    });
    expect((await screen.findByRole("alert")).textContent).toBe("eve is not a participant");
  });

  it("uses avatar pictures when given", async () => {
    render(
      <MementoChat
        chatId="123"
        userId="igor"
        avatarUrl={(id) => (id === "igor" ? "/igor.png" : undefined)}
      />,
      { wrapper: wrapper(fakeFetch(() => [message("igor", "hi"), message("ana", "hey")])) },
    );
    await waitFor(() => expect(texts()).toHaveLength(2));
    expect(document.querySelector("img.memento-avatar")?.getAttribute("src")).toBe("/igor.png");
    expect(document.querySelectorAll("span.memento-avatar")).toHaveLength(1);
  });
});

const participant = (user_id: string, last_seen_event_id: string | null = null) => ({
  user_id,
  added_at: "2026-10-30T09:00:00.000Z",
  last_seen_event_id,
  last_seen_at: last_seen_event_id ? "2026-10-30T10:00:00.000Z" : null,
});

const chatEvent = (event_type: string, actor: string, payload: Record<string, unknown>) =>
  makeEvent({
    event_type,
    instance_type: "chat",
    instance_id: "chat-123",
    actor_id: actor,
    payload,
  });

describe("MementoChat, read-only with seen markers and system lines", () => {
  it("cannot send: the composer is disabled with the reason as its tooltip", async () => {
    const fetch = fakeFetch(() => []);
    render(<MementoChat chatId="123" userId="igor" readOnly="read-only demo key" />, {
      wrapper: wrapper(fetch),
    });
    expect(await screen.findByText("No messages yet.")).toBeTruthy();
    const input = screen.getByLabelText("Message") as HTMLInputElement;
    const button = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(input.disabled).toBe(true);
    expect(button.disabled).toBe(true);
    expect(input.placeholder).toBe("Reading as igor");
    expect(input.title).toBe("read-only demo key");
    expect((input.closest("form") as HTMLFormElement).title).toBe("read-only demo key");
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows who read how far as the viewer sees it, and follows the stream", async () => {
    const first = message("marko", "I took T-3.");
    const second = message("ana", "Uzimam T-4.");
    const third = message("marko", "Thanks!");
    const added = chatEvent("CHAT_PARTICIPANT_ADDED", "igor", {
      user_id: "mila",
      added_by: "igor",
    });
    const fetch = fakeFetch((url) => {
      if (url.pathname === "/memento/chats/chat-123") {
        return {
          chat_id: "chat-123",
          participants: [
            participant("igor", first.id),
            participant("marko", third.id),
            participant("ana", first.id),
          ],
        };
      }
      if (url.searchParams.get("event_type") === "CHAT_PARTICIPANT_ADDED") return [added];
      return [third, second, first];
    });
    render(<MementoChat chatId="123" userId="igor" seenMarkers systemEvents />, {
      wrapper: wrapper(fetch, { locale: "sr" }),
    });
    await waitFor(() => expect(screen.getAllByTestId("seen-by")).toHaveLength(1));
    // ana read the first message (igor's own watermark is not shown to igor); marko wrote the
    // third one, so his watermark there says nothing.
    const seen = screen.getByTestId("seen-by");
    expect(seen.textContent).toBe("✓ Seen by ana");
    expect(seen.closest("li")?.dataset.eventId).toBe(first.id);
    // igor read up to the first: the unread messages start with the second.
    const divider = screen.getByTestId("unread");
    expect(divider.textContent).toBe("New messages");
    expect((divider.nextElementSibling as HTMLElement).dataset.eventId).toBe(second.id);
    // The system line, as memento rendered it.
    expect(document.querySelector(".memento-chat__notice")?.textContent).toContain(added.rendered);

    const socket = FakeSocket.last();
    expect(socket.query).toEqual({ instance_type: "chat", instance_id: "chat-123", locale: "sr" });
    act(() =>
      socket.push(
        chatEvent("CHAT_MESSAGE_SEEN", "ana", { user_id: "ana", messages_read_up_to: third.id }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("seen-by").closest("li")?.dataset.eventId).toBe(third.id),
    );
    const joined = chatEvent("CHAT_PARTICIPANT_ADDED", "ana", { user_id: "luka", added_by: "ana" });
    act(() => socket.push(joined));
    expect(document.querySelectorAll(".memento-chat__notice")).toHaveLength(2);
  });

  it("computes the markers per viewer", () => {
    const a = message("marko", "a");
    const b = message("ana", "b");
    const c = message("igor", "c");
    const d = message("marko", "d");
    const people = [
      participant("igor", a.id),
      participant("marko", c.id),
      participant("ana", null),
    ];
    const asIgor = seenMarkers([a, b, c, d], people, "igor");
    expect([...asIgor.seenBy]).toEqual([[c.id, ["marko"]]]);
    // igor wrote c: everything before it counts as read.
    expect(asIgor.unreadFrom).toBe(d.id);
    const asAna = seenMarkers([a, b, c, d], people, "ana");
    expect([...asAna.seenBy]).toEqual([
      [a.id, ["igor"]],
      [c.id, ["marko"]],
    ]);
    // ana never marked anything, but she wrote b: unread starts after it.
    expect(asAna.unreadFrom).toBe(c.id);
    expect(seenMarkers([a], [participant("igor", a.id)], "igor").unreadFrom).toBeNull();
    expect(seenMarkers([a], [], "igor")).toEqual({ seenBy: new Map(), unreadFrom: null });
  });

  it("applies seen and added events to the participants", () => {
    const start = [participant("igor")];
    const seen = chatEvent("CHAT_MESSAGE_SEEN", "igor", {
      user_id: "igor",
      messages_read_up_to: "e1",
    });
    expect(applyChatEvent(start, seen)[0]?.last_seen_event_id).toBe("e1");
    const added = chatEvent("CHAT_PARTICIPANT_ADDED", "igor", { user_id: "ana" });
    expect(applyChatEvent(start, added).map((p) => p.user_id)).toEqual(["igor", "ana"]);
    expect(applyChatEvent(applyChatEvent(start, added), added)).toHaveLength(2);
    expect(applyChatEvent(start, chatEvent("CHAT_MESSAGE_SEEN", "x", {}))).toBe(start);
    expect(applyChatEvent(start, message("igor", "hi"))).toBe(start);
  });
});

describe("chat helpers", () => {
  it("reads sender and text from the payload, falling back to the event", () => {
    const bare = makeEvent({ payload: {}, actor_id: null, rendered: null });
    expect(messageText(bare)).toBe("");
    expect(messageSender(bare)).toBe("unknown");
    expect(messageText(makeEvent({ payload: {}, rendered: "r" }))).toBe("r");
    expect(messageSender(makeEvent({ payload: {}, actor_id: "a" }))).toBe("a");
  });

  it("makes initials and stable hues", () => {
    expect(initials("igor")).toBe("IG");
    expect(initials("ana marija")).toBe("AM");
    expect(initials("marko.petrovic")).toBe("MP");
    expect(initials("--")).toBe("?");
    expect(hue("igor")).toBe(hue("igor"));
    expect(hue("igor")).toBeGreaterThanOrEqual(0);
    expect(hue("igor")).toBeLessThan(360);
    render(<Avatar userId="šime" />);
    expect(screen.getByText("ŠI")).toBeTruthy();
  });
});
