import { chatInstanceId, type MementoEvent } from "@memento/core";
import {
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { formatTime, hue, initials, type TimeFormat } from "./format.js";
import { useMementoChat } from "./hooks.js";
import { StatusIndicator } from "./StatusIndicator.js";

/** The text of a CHAT_MESSAGE_SENT event: its `payload.content`, else `rendered`. */
export function messageText(event: MementoEvent): string {
  const content = event.payload.content;
  return typeof content === "string" ? content : (event.rendered ?? "");
}

/** The sender of a message: `payload.sender_user_id`, else the actor. */
export function messageSender(event: MementoEvent): string {
  const sender = event.payload.sender_user_id;
  return typeof sender === "string" ? sender : (event.actor_id ?? "unknown");
}

export interface AvatarProps {
  userId: string;
  /** Picture URL; default: the user's initials on a colour of their own. */
  src?: string | undefined;
}

export function Avatar({ userId, src }: AvatarProps) {
  if (src) return <img className="memento-avatar" src={src} alt="" />;
  return (
    <span
      className="memento-avatar"
      aria-hidden="true"
      style={{ "--memento-avatar-hue": hue(userId) } as CSSProperties}
    >
      {initials(userId)}
    </span>
  );
}

export interface MementoChatProps extends TimeFormat {
  /** `123` or `chat-123`. */
  chatId: string;
  /** Who is reading and writing: must be a participant. */
  userId: string;
  title?: ReactNode;
  /** A picture for a user; default: initials. */
  avatarUrl?: (userId: string) => string | undefined;
  /** Display name for a user id. Default: the id. */
  displayName?: (userId: string) => string;
  /** Messages loaded at first. Default 100. */
  limit?: number;
}

/** A chat: the messages of `chatId` as `userId` sees them, live, and a box to write one. */
export function MementoChat({
  chatId,
  userId,
  title,
  avatarUrl,
  displayName = (id) => id,
  limit = 100,
  locale,
  timeZone,
}: MementoChatProps) {
  const { messages, status, loading, error, sending, send } = useMementoChat(chatId, userId, {
    limit,
  });
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLOListElement>(null);
  const id = useId();

  // Keep the newest message in view.
  const newest = messages.at(-1)?.id;
  useEffect(() => {
    const list = listRef.current;
    if (newest && list) list.scrollTop = list.scrollHeight;
  }, [newest]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    try {
      await send(content);
      setDraft("");
    } catch {
      // `error` shows what went wrong; the draft is kept so it can be sent again.
    }
  };

  return (
    <section className="memento memento-chat" aria-labelledby={`${id}-title`}>
      <header className="memento-toolbar">
        <h2 id={`${id}-title`} className="memento-title">
          {title ?? chatInstanceId(chatId)}
        </h2>
        <StatusIndicator status={status} />
      </header>
      <ol className="memento-chat__messages" ref={listRef} aria-label="Messages">
        {messages.length === 0 ? (
          <li className="memento-chat__empty">
            {loading ? "Loading messages…" : "No messages yet. Write the first one."}
          </li>
        ) : (
          messages.map((message) => {
            const sender = messageSender(message);
            const own = sender === userId;
            return (
              <li
                key={message.id}
                className="memento-message"
                data-own={own || undefined}
                data-event-id={message.id}
              >
                <Avatar userId={sender} src={avatarUrl?.(sender)} />
                <div className="memento-message__body">
                  <div className="memento-message__meta">
                    <span className="memento-message__sender">{displayName(sender)}</span>
                    <time dateTime={message.occurred_at}>
                      {formatTime(message.occurred_at, { locale, timeZone })}
                    </time>
                  </div>
                  <p className="memento-message__text">{messageText(message)}</p>
                </div>
              </li>
            );
          })
        )}
      </ol>
      {error ? (
        <p className="memento-error" role="alert">
          {error.message}
        </p>
      ) : null}
      <form className="memento-chat__compose" onSubmit={submit}>
        <label className="memento-visually-hidden" htmlFor={`${id}-input`}>
          Message
        </label>
        <input
          id={`${id}-input`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Message as ${displayName(userId)}`}
          autoComplete="off"
          maxLength={10_000}
        />
        <button type="submit" disabled={sending || draft.trim() === ""}>
          {sending ? "Sending…" : "Send"}
        </button>
      </form>
    </section>
  );
}
