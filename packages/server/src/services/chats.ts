import { randomUUID } from "node:crypto";
import {
  CHAT_EVENT_TYPES,
  CHAT_ID_PREFIX,
  CHAT_INSTANCE_TYPE,
  type Chat,
  type ChatCreateInput,
  ChatCreateSchema,
  ChatListQuerySchema,
  type ChatMessageInput,
  ChatMessageInputSchema,
  type ChatMessageResult,
  ChatMessagesQuerySchema,
  type ChatParticipant,
  type ChatParticipantInput,
  ChatParticipantInputSchema,
  type ChatParticipantResult,
  type ChatSeenInput,
  ChatSeenInputSchema,
  type ChatSeenResult,
  hasScope,
  type PageMeta,
} from "@memento/core";
import { and, asc, desc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import type { z } from "zod";
import { requireTenant } from "../context.js";
import type { Database } from "../db/client.js";
import { chatParticipants, chats, events } from "../db/schema.js";
import { MementoError } from "../errors.js";
import {
  type EventPage,
  type ListOptions,
  listEvents,
  type PushOptions,
  pushEvent,
} from "./events.js";
import { isUniqueViolation } from "./pg.js";

type ChatRow = typeof chats.$inferSelect;
type ParticipantRow = typeof chatParticipants.$inferSelect;

export function serializeParticipant(row: ParticipantRow): ChatParticipant {
  return {
    user_id: row.userId,
    added_at: row.addedAt.toISOString(),
    last_seen_event_id: row.lastSeenEventId,
    last_seen_at: row.lastSeenAt?.toISOString() ?? null,
  };
}

export function serializeChat(row: ChatRow, participants: ParticipantRow[]): Chat {
  return {
    chat_id: row.instanceId,
    instance_type: CHAT_INSTANCE_TYPE,
    instance_id: row.instanceId,
    kind: row.kind,
    name: row.name,
    participants: participants.map(serializeParticipant),
    created_at: row.createdAt.toISOString(),
    last_message_at: row.lastMessageAt?.toISOString() ?? null,
    archived_at: row.archivedAt?.toISOString() ?? null,
  };
}

function parse<T extends z.ZodType>(schema: T, input: unknown, what: string): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new MementoError("validation_error", `invalid ${what}`, parsed.error.issues);
  }
  return parsed.data;
}

/** A chat of the current tenant with its participants (oldest member first). */
interface LoadedChat {
  row: ChatRow;
  participants: ParticipantRow[];
}

async function loadChat(db: Database, chatId: string): Promise<LoadedChat> {
  const tenant = requireTenant();
  const [row] = await db
    .select()
    .from(chats)
    .where(and(eq(chats.tenantId, tenant.tenantId), eq(chats.instanceId, chatId)));
  if (!row) throw new MementoError("not_found", `chat "${chatId}" not found`);
  const participants = await db
    .select()
    .from(chatParticipants)
    .where(eq(chatParticipants.chatId, row.id))
    .orderBy(asc(chatParticipants.addedAt), asc(chatParticipants.userId));
  return { row, participants };
}

function participantOf(chat: LoadedChat, userId: string): ParticipantRow {
  const participant = chat.participants.find((p) => p.userId === userId);
  if (!participant) {
    throw new MementoError(
      "forbidden",
      `user "${userId}" is not a participant of ${chat.row.instanceId}`,
    );
  }
  return participant;
}

/**
 * Reads are made on behalf of a user: `user_id` must be a participant. Only an `admin`
 * key may read without naming one (moderation, exports).
 */
function authorizeReader(chat: LoadedChat | null, userId: string | undefined): void {
  if (userId === undefined) {
    if (!hasScope(requireTenant().scopes, "admin")) {
      throw new MementoError("forbidden", "user_id is required (only admin keys may omit it)");
    }
    return;
  }
  if (chat) participantOf(chat, userId);
}

function assertWritable(chat: LoadedChat): void {
  if (chat.row.archivedAt) {
    throw new MementoError("conflict", `${chat.row.instanceId} is archived`);
  }
}

/** Creates a chat (`chat-<id>`) and its participants for the current tenant. */
export async function createChat(db: Database, input: ChatCreateInput): Promise<Chat> {
  const tenant = requireTenant();
  const data = parse(ChatCreateSchema, input, "chat");
  const instanceId = data.chat_id ?? `${CHAT_ID_PREFIX}${randomUUID()}`;
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(chats)
        .values({
          tenantId: tenant.tenantId,
          instanceId,
          kind: data.kind,
          name: data.name ?? null,
        })
        .returning();
      const chat = row as ChatRow;
      const participants = await tx
        .insert(chatParticipants)
        .values(
          data.participants.map((userId) => ({
            tenantId: tenant.tenantId,
            chatId: chat.id,
            userId,
            addedAt: chat.createdAt,
          })),
        )
        .returning();
      return serializeChat(chat, participants);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new MementoError("conflict", `chat "${instanceId}" already exists`);
    }
    throw error;
  }
}

/** One chat; `userId` (a participant) is required unless the key is an admin key. */
export async function getChat(db: Database, chatId: string, userId?: string): Promise<Chat> {
  const chat = await loadChat(db, chatId);
  authorizeReader(chat, userId);
  return serializeChat(chat.row, chat.participants);
}

export interface ChatPage {
  chats: Chat[];
  meta: PageMeta;
}

/** Chats `user_id` participates in, most recently active first. */
export async function listChats(db: Database, input: Record<string, unknown>): Promise<ChatPage> {
  const tenant = requireTenant();
  const query = parse(ChatListQuerySchema, input, "query");
  authorizeReader(null, query.user_id);
  const where: (SQL | undefined)[] = [eq(chats.tenantId, tenant.tenantId)];
  if (query.user_id !== undefined) {
    where.push(
      inArray(
        chats.id,
        db
          .select({ id: chatParticipants.chatId })
          .from(chatParticipants)
          .where(
            and(
              eq(chatParticipants.tenantId, tenant.tenantId),
              eq(chatParticipants.userId, query.user_id),
            ),
          ),
      ),
    );
  }
  const rows = await db
    .select()
    .from(chats)
    .where(and(...where))
    .orderBy(desc(sql`coalesce(${chats.lastMessageAt}, ${chats.createdAt})`), desc(chats.id))
    .limit(query.limit + 1)
    .offset(query.offset);
  const page = rows.slice(0, query.limit);
  const members =
    page.length === 0
      ? []
      : await db
          .select()
          .from(chatParticipants)
          .where(
            inArray(
              chatParticipants.chatId,
              page.map((row) => row.id),
            ),
          )
          .orderBy(asc(chatParticipants.addedAt), asc(chatParticipants.userId));
  return {
    chats: page.map((row) =>
      serializeChat(
        row,
        members.filter((m) => m.chatId === row.id),
      ),
    ),
    meta: {
      limit: query.limit,
      count: page.length,
      next_cursor: null,
      offset: query.offset,
      next_offset: rows.length > query.limit ? query.offset + page.length : null,
    },
  };
}

/** Pushes a CHAT_MESSAGE_SENT event from `user_id` (a participant) into the chat. */
export async function sendMessage(
  db: Database,
  chatId: string,
  input: ChatMessageInput,
  options: PushOptions,
): Promise<ChatMessageResult> {
  const data = parse(ChatMessageInputSchema, input, "message");
  const chat = await loadChat(db, chatId);
  assertWritable(chat);
  participantOf(chat, data.user_id);
  const occurredAt = new Date(data.occurred_at ?? Date.now()).toISOString();
  const event = await pushEvent(
    db,
    {
      event_type: CHAT_EVENT_TYPES.messageSent,
      instance_type: CHAT_INSTANCE_TYPE,
      instance_id: chat.row.instanceId,
      actor_id: data.user_id,
      occurred_at: occurredAt,
      payload: { content: data.content, sender_user_id: data.user_id, timestamp: occurredAt },
    },
    options,
  );
  // Denormalized activity time; only ever moves forward (messages may arrive out of order).
  await db
    .update(chats)
    .set({
      lastMessageAt: sql`greatest(coalesce(${chats.lastMessageAt}, ${occurredAt}::timestamptz), ${occurredAt}::timestamptz)`,
    })
    .where(eq(chats.id, chat.row.id));
  return { event_id: event.id, message: event, rendered: event.rendered };
}

/** The chat's message `eventId`, or its newest message when `eventId` is undefined. */
async function findMessage(
  db: Database,
  chat: LoadedChat,
  eventId: string | undefined,
): Promise<{ id: string; occurredAt: Date }> {
  const where = [
    eq(events.tenantId, chat.row.tenantId),
    eq(events.instanceType, CHAT_INSTANCE_TYPE),
    eq(events.instanceId, chat.row.instanceId),
    eq(events.eventType, CHAT_EVENT_TYPES.messageSent),
    isNull(events.archivedAt),
  ];
  if (eventId) where.push(eq(events.id, eventId));
  const [row] = await db
    .select({ id: events.id, occurredAt: events.occurredAt })
    .from(events)
    .where(and(...where))
    .orderBy(desc(events.occurredAt), desc(events.id))
    .limit(1);
  if (row) return row;
  throw eventId
    ? new MementoError("not_found", `message ${eventId} not found in ${chat.row.instanceId}`)
    : new MementoError("conflict", `${chat.row.instanceId} has no messages yet`);
}

/**
 * Moves `user_id`'s read watermark to `up_to_event_id` (default: the newest message) and
 * pushes CHAT_MESSAGE_SEEN. A watermark never moves back: marking an older (or the same)
 * message as seen is a no-op that pushes nothing (`advanced: false`).
 */
export async function markSeen(
  db: Database,
  chatId: string,
  input: ChatSeenInput,
  options: PushOptions,
): Promise<ChatSeenResult> {
  const data = parse(ChatSeenInputSchema, input, "seen marker");
  const chat = await loadChat(db, chatId);
  assertWritable(chat);
  const current = participantOf(chat, data.user_id);
  const message = await findMessage(db, chat, data.up_to_event_id);
  const at = message.occurredAt.toISOString();
  const [updated] = await db
    .update(chatParticipants)
    .set({ lastSeenEventId: message.id, lastSeenAt: message.occurredAt })
    .where(
      and(
        eq(chatParticipants.chatId, chat.row.id),
        eq(chatParticipants.userId, data.user_id),
        or(
          isNull(chatParticipants.lastSeenAt),
          sql`(${chatParticipants.lastSeenAt}, ${chatParticipants.lastSeenEventId}) < (${at}::timestamptz, ${message.id}::uuid)`,
        ),
      ),
    )
    .returning();
  if (!updated) {
    const [latest] = await db
      .select()
      .from(chatParticipants)
      .where(
        and(eq(chatParticipants.chatId, chat.row.id), eq(chatParticipants.userId, data.user_id)),
      );
    return {
      event_id: null,
      event: null,
      rendered: null,
      advanced: false,
      participant: serializeParticipant(latest ?? current),
    };
  }
  const event = await pushEvent(
    db,
    {
      event_type: CHAT_EVENT_TYPES.messageSeen,
      instance_type: CHAT_INSTANCE_TYPE,
      instance_id: chat.row.instanceId,
      actor_id: data.user_id,
      payload: { user_id: data.user_id, messages_read_up_to: message.id },
    },
    options,
  );
  return {
    event_id: event.id,
    event,
    rendered: event.rendered,
    advanced: true,
    participant: serializeParticipant(updated),
  };
}

/** Adds `user_id` to a room chat and pushes CHAT_PARTICIPANT_ADDED. */
export async function addParticipant(
  db: Database,
  chatId: string,
  input: ChatParticipantInput,
  options: PushOptions,
): Promise<ChatParticipantResult> {
  const tenant = requireTenant();
  const data = parse(ChatParticipantInputSchema, input, "participant");
  const chat = await loadChat(db, chatId);
  assertWritable(chat);
  if (chat.row.kind === "direct") {
    throw new MementoError(
      "conflict",
      `${chat.row.instanceId} is a direct chat: its participants are fixed (create a room)`,
    );
  }
  if (data.added_by !== undefined) participantOf(chat, data.added_by);
  const [row] = await db
    .insert(chatParticipants)
    .values({ tenantId: tenant.tenantId, chatId: chat.row.id, userId: data.user_id })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    throw new MementoError(
      "conflict",
      `user "${data.user_id}" is already a participant of ${chat.row.instanceId}`,
    );
  }
  const event = await pushEvent(
    db,
    {
      event_type: CHAT_EVENT_TYPES.participantAdded,
      instance_type: CHAT_INSTANCE_TYPE,
      instance_id: chat.row.instanceId,
      actor_id: data.added_by ?? null,
      payload: {
        user_id: data.user_id,
        ...(data.added_by !== undefined ? { added_by: data.added_by } : {}),
      },
    },
    options,
  );
  return {
    event_id: event.id,
    event,
    rendered: event.rendered,
    participant: serializeParticipant(row),
  };
}

/**
 * A chat's messages (`CHAT_MESSAGE_SENT`; `?event_type=CHAT_*` for every chat event), with
 * `limit`/`offset` pagination and `rendered` in `?locale`.
 */
export async function listChatMessages(
  db: Database,
  chatId: string,
  input: Record<string, unknown>,
  options: ListOptions = {},
): Promise<EventPage> {
  const query = parse(ChatMessagesQuerySchema, input, "query");
  const chat = await loadChat(db, chatId);
  authorizeReader(chat, query.user_id);
  return listEvents(
    db,
    {
      instance_type: CHAT_INSTANCE_TYPE,
      instance_id: chat.row.instanceId,
      event_type: query.event_type,
      limit: query.limit,
      offset: query.offset,
      order: query.order,
      ...(query.locale ? { locale: query.locale } : {}),
    },
    null,
    options,
  );
}
