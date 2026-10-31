import "@memento/react/styles.css";
import { useI18n } from "@jsudc/react";
import { Spinner } from "@jsudc/react/ui";
import { MementoChat, MementoProvider, useMemento } from "@memento/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import { useSearchParams } from "react-router";
import { useSettings } from "../../connection.js";
import { useLive } from "../../live.js";
import { Connected } from "../../shell/AppShell.js";
import { SIMULATOR_COMMAND } from "../activity/Activity.js";
import {
  changesRoom,
  chooseViewer,
  loadRoom,
  participantIds,
  ROOM_ID,
  VIEWER_PARAM,
} from "./chat.js";

/**
 * The Chat example (`/examples/chat`): the room `memento simulate` talks in, shown with
 * `MementoChat` from `@memento/react` as one of its participants (a selector on top), live,
 * read-only — the demo key may not write, so the composer is disabled.
 */
export function ChatPage() {
  const { t, locale } = useI18n();
  const { connection } = useSettings();
  return (
    <div className="page">
      <header className="bar">
        <div className="bar__title">
          <h1>{t("CHAT", "TITLE")}</h1>
          <span className="bar__sub">{t("CHAT", "SUBTITLE")}</span>
        </div>
      </header>
      <Connected>
        {/* The header's language: memento renders the system lines ("ana was added") in it. */}
        <MementoProvider
          key={`${connection.baseUrl}|${connection.apiKey}`}
          baseUrl={connection.baseUrl}
          apiKey={connection.apiKey}
          locale={locale}
        >
          <Room />
        </MementoProvider>
      </Connected>
    </div>
  );
}

function Room() {
  const { t } = useI18n();
  const { client, baseUrl, apiKey } = useMemento();
  const { connection } = useSettings();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const id = useId();
  const queryKey = ["memento-chat-room", baseUrl, apiKey, ROOM_ID];
  const room = useQuery({ queryKey, queryFn: () => loadRoom(client) });
  const known = Boolean(room.data);
  // The room appearing (the simulator started) and new members: read the room again.
  useLive({
    baseUrl,
    apiKey,
    filter: { instance_type: "chat", instance_id: ROOM_ID },
    onEvent: (event) => {
      if (changesRoom(event.event_type, known)) void queryClient.invalidateQueries({ queryKey });
    },
  });

  if (room.isLoading) {
    return (
      <div className="page__center">
        <Spinner />
      </div>
    );
  }
  if (room.error) {
    return (
      <p className="feed__error" role="alert">
        {room.error.message}
      </p>
    );
  }
  if (!room.data) {
    return (
      <div className="feed__empty" data-testid="chat-empty">
        <p>{t("CHAT", "EMPTY")}</p>
        <code>{SIMULATOR_COMMAND}</code>
      </div>
    );
  }

  const ids = participantIds(room.data);
  const viewer = chooseViewer(ids, params.get(VIEWER_PARAM)) as string;
  const readOnly =
    connection.source === "demo" ? t("CHAT", "READ_ONLY_DEMO") : t("CHAT", "READ_ONLY");
  return (
    <section className="chat" data-testid="chat">
      <div className="chat__viewer">
        <label htmlFor={`${id}-viewer`}>{t("CHAT", "VIEW_AS")}</label>
        <select
          id={`${id}-viewer`}
          data-testid="chat-viewer"
          value={viewer}
          onChange={(e) => setParams({ [VIEWER_PARAM]: e.target.value }, { replace: true })}
        >
          {ids.map((user) => (
            <option key={user} value={user}>
              {user}
            </option>
          ))}
        </select>
        <span className="chat__members">{t("CHAT", "MEMBERS", { count: ids.length })}</span>
        <p className="chat__hint">{t("CHAT", "VIEW_AS_HINT")}</p>
      </div>
      <MementoChat
        key={viewer}
        chatId={ROOM_ID}
        userId={viewer}
        title={room.data.name ?? t("CHAT", "ROOM")}
        readOnly={readOnly}
        seenMarkers
        systemEvents
      />
    </section>
  );
}
