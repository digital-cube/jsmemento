import {
  MementoChat,
  MementoDataView,
  MementoProvider,
  MementoSearch,
  useMemento,
} from "@memento/react";
import { type FormEvent, useState } from "react";

const KEY_STORAGE = "memento-example:api-key";
const BASE_URL = "/memento";

type Tab = "events" | "search" | "chat";
const TABS: { id: Tab; label: string }[] = [
  { id: "events", label: "Live events" },
  { id: "search", label: "Search" },
  { id: "chat", label: "Chat" },
];

export function App() {
  const [apiKey, setApiKey] = useState(
    () => localStorage.getItem(KEY_STORAGE) ?? import.meta.env.VITE_MEMENTO_API_KEY ?? "",
  );
  const [connected, setConnected] = useState(apiKey !== "");

  if (!connected) {
    return (
      <KeyForm
        initial={apiKey}
        onSubmit={(key) => {
          localStorage.setItem(KEY_STORAGE, key);
          setApiKey(key);
          setConnected(true);
        }}
      />
    );
  }

  return (
    <MementoProvider baseUrl={BASE_URL} apiKey={apiKey}>
      <Dashboard
        apiKey={apiKey}
        onForget={() => {
          localStorage.removeItem(KEY_STORAGE);
          setApiKey("");
          setConnected(false);
        }}
      />
    </MementoProvider>
  );
}

function KeyForm({ initial, onSubmit }: { initial: string; onSubmit: (key: string) => void }) {
  const [key, setKey] = useState(initial);
  const valid = /^mk_[A-Za-z0-9]{8}_\S+$/.test(key.trim());
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) onSubmit(key.trim());
  };
  return (
    <main className="key-screen">
      <h1 className="wordmark">memento</h1>
      <p className="key-screen__lede">
        Watch what happens in your system as it happens. Paste an API key to open the live event
        table.
      </p>
      <form className="key-form" onSubmit={submit}>
        <label htmlFor="api-key">API key</label>
        <input
          id="api-key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="mk_ab12cd34_…"
          spellCheck={false}
          autoComplete="off"
        />
        <button type="submit" disabled={!valid}>
          Open the event table
        </button>
      </form>
      <p className="key-screen__help">
        No key yet? Create one with read and write scopes:
        <code>pnpm memento create-key --tenant acme --scopes read,write --name example-app</code>
        The key stays in this browser only.
      </p>
    </main>
  );
}

function Dashboard({ apiKey, onForget }: { apiKey: string; onForget: () => void }) {
  const [tab, setTab] = useState<Tab>("events");
  return (
    <div className="shell">
      <header className="shell__header">
        <span className="wordmark wordmark--small">memento</span>
        <nav className="tabs" aria-label="Views">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className="tabs__tab"
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <TestEventButton />
        <span className="shell__key" title="The key this page uses">
          {apiKey.slice(0, 11)}…
        </span>
        <button type="button" className="shell__forget" onClick={onForget}>
          Use another key
        </button>
      </header>
      <main className="shell__main">
        {tab === "events" ? <MementoDataView title="Live events" /> : null}
        {tab === "search" ? <MementoSearch /> : null}
        {tab === "chat" ? <ChatTab /> : null}
      </main>
    </div>
  );
}

/** Pushes a NOTE so there is something to watch arrive (needs the write scope). */
function TestEventButton() {
  const { baseUrl, apiKey } = useMemento();
  const [state, setState] = useState<"idle" | "sending" | "sent" | string>("idle");
  const send = async () => {
    setState("sending");
    const response = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        event_type: "NOTE",
        instance_type: "user",
        instance_id: "example-app",
        actor_id: "example-app",
        payload: { text: `Test event sent at ${new Date().toLocaleTimeString()}` },
      }),
    }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as {
      error?: { message: string };
    } | null;
    setState(response?.ok ? "sent" : (body?.error?.message ?? "the server did not answer"));
  };
  const failed = !["idle", "sending", "sent"].includes(state);
  return (
    <span className="test-event">
      <button type="button" onClick={send} disabled={state === "sending"}>
        Send a test event
      </button>
      {failed ? (
        <span className="test-event__error" role="alert">
          {state}
        </span>
      ) : null}
    </span>
  );
}

function ChatTab() {
  const [chatId, setChatId] = useState(import.meta.env.VITE_MEMENTO_CHAT_ID ?? "");
  const [userId, setUserId] = useState(import.meta.env.VITE_MEMENTO_USER_ID ?? "");
  const [open, setOpen] = useState<{ chatId: string; userId: string } | null>(
    chatId && userId ? { chatId, userId } : null,
  );
  return (
    <div className="chat-tab">
      <form
        className="chat-tab__form"
        onSubmit={(e) => {
          e.preventDefault();
          if (chatId.trim() && userId.trim()) {
            setOpen({ chatId: chatId.trim(), userId: userId.trim() });
          }
        }}
      >
        <label>
          Chat
          <input
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder="chat-123"
          />
        </label>
        <label>
          You are
          <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="igor" />
        </label>
        <button type="submit">Open chat</button>
      </form>
      {open ? (
        <MementoChat key={`${open.chatId}/${open.userId}`} {...open} />
      ) : (
        <p className="chat-tab__hint">
          Open a chat you take part in. Create one with
          <code>pnpm memento create-chat --tenant acme --participants igor,marko</code>
        </p>
      )}
    </div>
  );
}
