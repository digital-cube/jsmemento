import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { SIMULATOR_COMMAND } from "../src/examples/activity/Activity.js";
import {
  changesRoom,
  chooseViewer,
  participantIds,
  ROOM_ID,
  ROOM_READER,
} from "../src/examples/chat/chat.js";
import { defaultSettings, STORAGE_KEY } from "../src/settings.js";
import { FakeSocket, uuid } from "./fake-socket.js";
import { udcServer } from "./udc-server.js";

/** The visitor has no key: the page runs on the server's read-only demo key. */
const settings = { ...defaultSettings({} as ImportMetaEnv), apiKey: "" };
const DEMO = { api_key: "mk_k", tenant: "demo" };

const participant = (user_id: string, last_seen_event_id: string | null) => ({
  user_id,
  added_at: "2026-10-31T09:00:00.000Z",
  last_seen_event_id,
  last_seen_at: last_seen_event_id ? "2026-10-31T10:00:30.000Z" : null,
});

const sent = (n: number, sender: string, content: string) => ({
  id: uuid(n),
  occurred_at: new Date(Date.UTC(2026, 9, 31, 10, 0, n)).toISOString(),
  received_at: new Date(Date.UTC(2026, 9, 31, 10, 0, n)).toISOString(),
  event_type: "CHAT_MESSAGE_SENT",
  instance_type: "chat",
  instance_id: ROOM_ID,
  actor_id: sender,
  payload: { content, sender_user_id: sender, timestamp: "2026-10-31T10:00:00.000Z" },
  rendered: `${sender} sent a message: "${content}"`,
  rendered_locale: "en",
  archived_at: null,
});

const MESSAGES = [
  sent(1, "marko", "I took T-17."),
  sent(2, "ana", "Zatvaram T-12, duplicate."),
  sent(3, "igor", "Thanks!"),
];
const JOINED = {
  ...sent(4, "igor", ""),
  event_type: "CHAT_PARTICIPANT_ADDED",
  payload: { user_id: "mila", added_by: "igor" },
};

interface ChatServer {
  /** `null`: the room does not exist (404). */
  room: { participants: ReturnType<typeof participant>[] } | null;
}

/** memento's chat endpoints over the examples' stub server. */
function chatServer(state: ChatServer) {
  const udc = udcServer({ demo: DEMO, feed: [] });
  const reads: URL[] = [];
  const writes: string[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (!url.pathname.startsWith("/memento/chats")) return udc.fetch(input, init);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer mk_k");
    if (init?.method === "POST") {
      writes.push(url.pathname);
      return json(403, { ok: false, error: { code: "forbidden", message: "read-only key" } });
    }
    reads.push(url);
    if (!state.room) {
      return json(404, { ok: false, error: { code: "not_found", message: "no such chat" } });
    }
    const user = url.searchParams.get("user_id") ?? "";
    if (!state.room.participants.some((p) => p.user_id === user)) {
      return json(403, { ok: false, error: { code: "forbidden", message: `${user} is not in` } });
    }
    const meta = { limit: 100, count: 0, next_cursor: null };
    if (url.pathname === `/memento/chats/${ROOM_ID}`) {
      return json(200, {
        ok: true,
        data: {
          chat_id: ROOM_ID,
          instance_type: "chat",
          instance_id: ROOM_ID,
          kind: "room",
          name: "Demo room",
          participants: state.room.participants,
          created_at: "2026-10-31T09:00:00.000Z",
          last_message_at: null,
          archived_at: null,
        },
      });
    }
    const sr = url.searchParams.get("locale") === "sr";
    if (url.searchParams.get("event_type") === "CHAT_PARTICIPANT_ADDED") {
      const rendered = sr ? "mila je dodat u čat" : "mila was added to the chat";
      return json(200, { ok: true, data: [{ ...JOINED, rendered }], meta });
    }
    return json(200, { ok: true, data: [...MESSAGES].reverse(), meta });
  });
  return { fetch, reads, writes };
}

const PEOPLE = [
  participant("igor", MESSAGES[1]?.id ?? null),
  participant("marko", MESSAGES[0]?.id ?? null),
  participant("ana", MESSAGES[2]?.id ?? null),
];

const texts = (root: HTMLElement) =>
  [...root.querySelectorAll(".memento-message__text")].map((el) => el.textContent);
const seenLines = () =>
  screen
    .queryAllByTestId("seen-by")
    .map((el) => [el.closest("li")?.dataset.eventId, el.textContent]);

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  FakeSocket.all = [];
  localStorage.clear();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  vi.stubGlobal("WebSocket", FakeSocket);
  errors = vi.spyOn(console, "error");
  history.replaceState(null, "", "/examples/chat");
});
afterEach(() => {
  vi.unstubAllGlobals();
  errors.mockRestore();
});

describe("the chat page", () => {
  it("shows the demo room as its first participant, read-only, with seen markers", async () => {
    const server = chatServer({ room: { participants: PEOPLE } });
    vi.stubGlobal("fetch", server.fetch);
    render(<App />);
    const page = await screen.findByTestId("chat");
    const viewer = within(page).getByTestId("chat-viewer") as HTMLSelectElement;
    expect([...viewer.options].map((o) => o.value)).toEqual(["igor", "marko", "ana"]);
    expect(viewer.value).toBe("igor");
    expect(within(page).getByText("3 participants")).toBeTruthy();
    expect(within(page).getByRole("heading", { name: "Demo room" })).toBeTruthy();
    await waitFor(() =>
      expect(texts(page)).toEqual(["I took T-17.", "Zatvaram T-12, duplicate.", "Thanks!"]),
    );
    // Read as igor: the room and its messages, on igor's behalf.
    expect(server.reads[0]?.searchParams.get("user_id")).toBe(ROOM_READER);
    const reads = server.reads.map((u) => u.searchParams.get("user_id"));
    expect(new Set(reads)).toEqual(new Set(["igor"]));
    // igor sees ana's watermark on his own message; marko's is on marko's own message, which
    // says nothing (he wrote it), and igor's own is not shown to igor.
    await waitFor(() => expect(seenLines()).toEqual([[MESSAGES[2]?.id, "✓ Seen by ana"]]));
    // igor wrote the newest message: nothing is new to him.
    expect(within(page).queryByTestId("unread")).toBeNull();
    expect(page.querySelector(".memento-chat__notice")?.textContent).toContain(
      "mila was added to the chat",
    );

    // The composer: disabled, with the reason as a tooltip; nothing can be sent.
    const input = within(page).getByLabelText("Message") as HTMLInputElement;
    const send = within(page).getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(input.disabled).toBe(true);
    expect(send.disabled).toBe(true);
    expect(input.title).toBe("read-only demo key");
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(server.writes).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });

  it("switches the viewer: reads as them, and the seen markers follow", async () => {
    const server = chatServer({ room: { participants: PEOPLE } });
    vi.stubGlobal("fetch", server.fetch);
    render(<App />);
    const page = await screen.findByTestId("chat");
    await waitFor(() => expect(seenLines()).toHaveLength(1));
    fireEvent.change(within(page).getByTestId("chat-viewer"), { target: { value: "marko" } });
    await waitFor(() => expect(location.search).toBe("?as=marko"));
    await waitFor(() =>
      expect(server.reads.some((u) => u.searchParams.get("user_id") === "marko")).toBe(true),
    );
    // As marko: igor's watermark now shows (on ana's message), and ana's on igor's.
    await waitFor(() =>
      expect(seenLines()).toEqual([
        [MESSAGES[1]?.id, "✓ Seen by igor"],
        [MESSAGES[2]?.id, "✓ Seen by ana"],
      ]),
    );
    // marko read up to his own first message: the rest is new to him.
    const divider = await within(page).findByTestId("unread");
    expect((divider.nextElementSibling as HTMLElement).dataset.eventId).toBe(MESSAGES[1]?.id);
    const own = page.querySelector(`[data-event-id="${MESSAGES[0]?.id}"]`) as HTMLElement;
    expect(own.dataset.own).toBe("true");
    expect((within(page).getByLabelText("Message") as HTMLInputElement).placeholder).toBe(
      "Reading as marko",
    );
  });

  it("opens on the viewer of the URL, and on the first one for somebody not in the room", async () => {
    vi.stubGlobal("fetch", chatServer({ room: { participants: PEOPLE } }).fetch);
    history.replaceState(null, "", "/examples/chat?as=ana");
    const { unmount } = render(<App />);
    expect(((await screen.findByTestId("chat-viewer")) as HTMLSelectElement).value).toBe("ana");
    unmount();
    history.replaceState(null, "", "/examples/chat?as=eve");
    render(<App />);
    expect(((await screen.findByTestId("chat-viewer")) as HTMLSelectElement).value).toBe("igor");
  });

  it("changes only the system lines with the language: people's messages are not translated", async () => {
    const server = chatServer({ room: { participants: PEOPLE } });
    vi.stubGlobal("fetch", server.fetch);
    render(<App />);
    const page = await screen.findByTestId("chat");
    await waitFor(() => expect(texts(page)).toHaveLength(3));
    fireEvent.click(screen.getByTestId("locale-sr"));
    await waitFor(() =>
      expect(page.querySelector(".memento-chat__notice")?.textContent).toContain(
        "mila je dodat u čat",
      ),
    );
    expect(texts(page)).toEqual(["I took T-17.", "Zatvaram T-12, duplicate.", "Thanks!"]);
    expect(within(page).getByText("Gledate kao")).toBeTruthy();
    expect((within(page).getByLabelText("Message") as HTMLInputElement).title).toBe(
      "demo ključ samo za čitanje",
    );
    // The messages are read again in the new locale (their `rendered`), the content is the same.
    expect(
      server.reads.some(
        (u) => u.pathname.endsWith("/messages") && u.searchParams.get("locale") === "sr",
      ),
    ).toBe(true);
  });

  it("follows the room live: new messages and read markers from the stream", async () => {
    vi.stubGlobal("fetch", chatServer({ room: { participants: PEOPLE } }).fetch);
    render(<App />);
    const page = await screen.findByTestId("chat");
    await waitFor(() => expect(texts(page)).toHaveLength(3));
    const chatSocket = FakeSocket.all.filter((s) => !s.closed && s.query.instance_id === ROOM_ID);
    expect(chatSocket.length).toBeGreaterThan(0);
    const next = sent(5, "marko", "Ko radi na T-18?");
    act(() => {
      for (const s of chatSocket) s.push(next.id, next);
    });
    await waitFor(() => expect(texts(page).at(-1)).toBe("Ko radi na T-18?"));
    act(() => {
      for (const s of chatSocket) {
        s.push(uuid(6), {
          event_type: "CHAT_MESSAGE_SEEN",
          instance_type: "chat",
          instance_id: ROOM_ID,
          actor_id: "ana",
          payload: { user_id: "ana", messages_read_up_to: next.id },
        });
      }
    });
    await waitFor(() => expect(seenLines()).toContainEqual([next.id, "✓ Seen by ana"]));
  });

  it("says how to start the simulator while the room does not exist, and shows it once it does", async () => {
    const state: ChatServer = { room: null };
    vi.stubGlobal("fetch", chatServer(state).fetch);
    render(<App />);
    const empty = await screen.findByTestId("chat-empty");
    expect(within(empty).getByText(SIMULATOR_COMMAND)).toBeTruthy();
    expect(empty.textContent).toContain("memento simulate creates it");
    expect(errors).not.toHaveBeenCalled();

    // The simulator starts: the first event of the room makes the page read it again.
    state.room = { participants: PEOPLE };
    const socket = FakeSocket.all.find(
      (s) => !s.closed && s.query.instance_id === ROOM_ID,
    ) as FakeSocket;
    act(() => socket.push(MESSAGES[0]?.id ?? "", MESSAGES[0]));
    expect(await screen.findByTestId("chat")).toBeTruthy();
  });
});

describe("chat helpers", () => {
  it("picks the viewer and knows which events change the room", () => {
    expect(chooseViewer(["igor", "ana"], "ana")).toBe("ana");
    expect(chooseViewer(["igor", "ana"], "eve")).toBe("igor");
    expect(chooseViewer(["igor"], null)).toBe("igor");
    expect(chooseViewer([], null)).toBeNull();
    expect(participantIds(null)).toEqual([]);
    expect(changesRoom("CHAT_MESSAGE_SENT", false)).toBe(true);
    expect(changesRoom("CHAT_MESSAGE_SENT", true)).toBe(false);
    expect(changesRoom("CHAT_PARTICIPANT_ADDED", true)).toBe(true);
  });
});
