import { type ChatParticipant, chatInstanceId, type MementoEvent } from "@memento/core";
import {
  type CSSProperties,
  type FormEvent,
  Fragment,
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

/**
 * Who has read how far, as `viewer` sees it: for each message, the other participants whose
 * read watermark is that message (its sender left out: they wrote it); and the first message
 * the viewer has not read yet (`null` when they are up to date). A watermark older than the
 * loaded messages counts as "before all of them".
 */
export function seenMarkers(
  messages: readonly MementoEvent[],
  participants: readonly ChatParticipant[],
  viewer: string,
): { seenBy: Map<string, string[]>; unreadFrom: string | null } {
  const index = new Map(messages.map((m, i) => [m.id, i]));
  const seenBy = new Map<string, string[]>();
  for (const p of participants) {
    if (p.user_id === viewer || !p.last_seen_event_id) continue;
    const at = index.get(p.last_seen_event_id);
    if (at === undefined) continue;
    const message = messages[at] as MementoEvent;
    if (messageSender(message) === p.user_id) continue;
    seenBy.set(message.id, [...(seenBy.get(message.id) ?? []), p.user_id]);
  }
  let unreadFrom: string | null = null;
  const me = participants.find((p) => p.user_id === viewer);
  if (me) {
    const read = me.last_seen_event_id ? (index.get(me.last_seen_event_id) ?? -1) : -1;
    // A message of the viewer's own after the watermark means they were there up to it.
    let from = read;
    messages.forEach((m, i) => {
      if (messageSender(m) === viewer && i > from) from = i;
    });
    const first = messages.findIndex((m, i) => i > from && messageSender(m) !== viewer);
    unreadFrom = first === -1 ? null : (messages[first] as MementoEvent).id;
  }
  return { seenBy, unreadFrom };
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
  /**
   * No writing: the composer is disabled and nothing can be sent. A string says why; it is
   * the composer's tooltip (e.g. "read-only demo key"). Default `false`.
   */
  readOnly?: boolean | string;
  /** Show who has read how far ("Seen by …") and where the user's unread messages start. */
  seenMarkers?: boolean;
  /** Show the chat's system lines (somebody was added), in the provider's locale. */
  systemEvents?: boolean;
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
  readOnly = false,
  seenMarkers: showSeen = false,
  systemEvents = false,
}: MementoChatProps) {
  const { messages, status, loading, error, sending, send, participants, notices } = useMementoChat(
    chatId,
    userId,
    { limit, seen: showSeen, system: systemEvents },
  );
  const locked = readOnly !== false;
  const why = typeof readOnly === "string" ? readOnly : locked ? "read-only" : undefined;
  const { seenBy, unreadFrom } = showSeen
    ? seenMarkers(messages, participants, userId)
    : { seenBy: new Map<string, string[]>(), unreadFrom: null };
  // Messages and system lines in one timeline, oldest first.
  const timeline = [...messages, ...notices].sort(
    (a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id),
  );
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
    if (!content || sending || locked) return;
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
        {timeline.length === 0 ? (
          <li className="memento-chat__empty">
            {loading
              ? "Loading messages…"
              : locked
                ? "No messages yet."
                : "No messages yet. Write the first one."}
          </li>
        ) : (
          timeline.map((message) => {
            if (message.event_type !== "CHAT_MESSAGE_SENT") {
              return (
                <li key={message.id} className="memento-chat__notice" data-event-id={message.id}>
                  <span>{message.rendered ?? message.event_type}</span>
                  <time dateTime={message.occurred_at}>
                    {formatTime(message.occurred_at, { locale, timeZone })}
                  </time>
                </li>
              );
            }
            const sender = messageSender(message);
            const own = sender === userId;
            const readers = seenBy.get(message.id);
            return (
              <Fragment key={message.id}>
                {message.id === unreadFrom ? (
                  <li className="memento-chat__unread" data-testid="unread">
                    New messages
                  </li>
                ) : null}
                <li
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
                    {readers ? (
                      <p className="memento-message__seen" data-testid="seen-by">
                        ✓ Seen by {readers.map(displayName).join(", ")}
                      </p>
                    ) : null}
                  </div>
                </li>
              </Fragment>
            );
          })
        )}
      </ol>
      {error ? (
        <p className="memento-error" role="alert">
          {error.message}
        </p>
      ) : null}
      <form
        className="memento-chat__compose"
        onSubmit={submit}
        title={why}
        data-readonly={locked || undefined}
      >
        <label className="memento-visually-hidden" htmlFor={`${id}-input`}>
          Message
        </label>
        <input
          id={`${id}-input`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            locked ? `Reading as ${displayName(userId)}` : `Message as ${displayName(userId)}`
          }
          autoComplete="off"
          maxLength={10_000}
          disabled={locked}
          title={why}
        />
        <button type="submit" disabled={locked || sending || draft.trim() === ""} title={why}>
          {sending ? "Sending…" : "Send"}
        </button>
      </form>
    </section>
  );
}
