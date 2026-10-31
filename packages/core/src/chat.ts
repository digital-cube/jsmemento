import { z } from "zod";
import { ActorIdSchema, IdSchema, TimestampSchema } from "./common.js";
import { EventSchema } from "./event.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./query.js";
import { LocaleSchema } from "./template.js";

/** A chat's events live under `instance_type = "chat"`, `instance_id = "chat-<id>"`. */
export const CHAT_INSTANCE_TYPE = "chat";
export const CHAT_ID_PREFIX = "chat-";

/** The event types memento pushes for chats. */
export const CHAT_EVENT_TYPES = {
  messageSent: "CHAT_MESSAGE_SENT",
  messageSeen: "CHAT_MESSAGE_SEEN",
  participantAdded: "CHAT_PARTICIPANT_ADDED",
} as const;

/** The instance id of a chat: `chatInstanceId("123")` → `chat-123`. */
export function chatInstanceId(id: string): string {
  return id.startsWith(CHAT_ID_PREFIX) ? id : `${CHAT_ID_PREFIX}${id}`;
}

/** `direct`: exactly two participants, fixed. `room`: participants can be added. */
export const ChatKindSchema = z.enum(["direct", "room"]);
export type ChatKind = z.infer<typeof ChatKindSchema>;

/** A chat id: `chat-` followed by the producer's id (or a generated UUID). */
export const ChatIdSchema = z
  .string()
  .max(200)
  .regex(/^chat-[A-Za-z0-9][\w.:-]*$/, 'chat_id looks like "chat-<id>"');

const MAX_PARTICIPANTS = 500;

/** `POST /memento/chats`. */
export const ChatCreateSchema = z
  .strictObject({
    participants: z.array(ActorIdSchema).min(1).max(MAX_PARTICIPANTS),
    name: z.string().trim().min(1).max(200).nullish(),
    /** Default: `direct` for exactly two participants, `room` otherwise. */
    kind: ChatKindSchema.optional(),
    /** The producer's own chat id (`123` or `chat-123`); default: a generated UUID. */
    chat_id: z
      .union([z.string(), z.number().int()])
      .transform((value) => chatInstanceId(String(value).trim()))
      .pipe(ChatIdSchema)
      .optional(),
  })
  .transform((input, ctx) => {
    const participants = [...new Set(input.participants)];
    const kind = input.kind ?? (participants.length === 2 ? "direct" : "room");
    if (kind === "direct" && participants.length !== 2) {
      ctx.issues.push({
        code: "custom",
        input: input.participants,
        path: ["participants"],
        message: "a direct chat has exactly two distinct participants",
      });
      return z.NEVER;
    }
    return { ...input, participants, kind };
  });
export type ChatCreateInput = z.input<typeof ChatCreateSchema>;
export type ChatCreate = z.output<typeof ChatCreateSchema>;

/** `POST /memento/chats/:chat_id/messages`. */
export const ChatMessageInputSchema = z.strictObject({
  content: z.string().trim().min(1).max(10_000),
  user_id: ActorIdSchema,
  /** When it was sent at the producer; default: now. */
  occurred_at: TimestampSchema.optional(),
});
export type ChatMessageInput = z.input<typeof ChatMessageInputSchema>;

/** `POST /memento/chats/:chat_id/seen`. */
export const ChatSeenInputSchema = z.strictObject({
  user_id: ActorIdSchema,
  /** The newest message read (inclusive); default: the chat's newest message. */
  up_to_event_id: IdSchema.optional(),
});
export type ChatSeenInput = z.input<typeof ChatSeenInputSchema>;

/** `POST /memento/chats/:chat_id/participants` (room chats). */
export const ChatParticipantInputSchema = z.strictObject({
  user_id: ActorIdSchema,
  /** Who added them; must be a participant already. */
  added_by: ActorIdSchema.optional(),
});
export type ChatParticipantInput = z.input<typeof ChatParticipantInputSchema>;

const userIdParam = z.string().trim().min(1).max(200).optional();

/** Query string of `GET /memento/chats/:chat_id/messages`. */
export const ChatMessagesQuerySchema = z.object({
  /** Read on behalf of this participant (required unless the key has the admin scope). */
  user_id: userIdParam,
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  order: z.enum(["asc", "desc"]).default("desc"),
  /** Default `CHAT_MESSAGE_SENT`; `CHAT_*` or `*` returns every event of the chat. */
  event_type: z.string().min(1).max(100).default(CHAT_EVENT_TYPES.messageSent),
  locale: LocaleSchema.optional(),
});
export type ChatMessagesQuery = z.output<typeof ChatMessagesQuerySchema>;

/** Query string of `GET /memento/chats`. */
export const ChatListQuerySchema = z.object({
  /** Chats this user participates in (required unless the key has the admin scope). */
  user_id: userIdParam,
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type ChatListQuery = z.output<typeof ChatListQuerySchema>;

/** One participant and their read watermark. */
export const ChatParticipantSchema = z.object({
  user_id: z.string(),
  added_at: TimestampSchema,
  /** Newest CHAT_MESSAGE_SENT event they have seen (inclusive); `null` = nothing yet. */
  last_seen_event_id: IdSchema.nullable(),
  last_seen_at: TimestampSchema.nullable(),
});
export type ChatParticipant = z.infer<typeof ChatParticipantSchema>;

/** A chat instance. Its messages are ordinary events of `chat/<chat_id>`. */
export const ChatSchema = z.object({
  chat_id: ChatIdSchema,
  instance_type: z.literal(CHAT_INSTANCE_TYPE),
  instance_id: ChatIdSchema,
  kind: ChatKindSchema,
  name: z.string().nullable(),
  participants: z.array(ChatParticipantSchema),
  created_at: TimestampSchema,
  last_message_at: TimestampSchema.nullable(),
  archived_at: TimestampSchema.nullable(),
});
export type Chat = z.infer<typeof ChatSchema>;

/** Response of `POST /memento/chats/:chat_id/messages`. */
export const ChatMessageResultSchema = z.object({
  event_id: IdSchema,
  message: EventSchema,
  rendered: z.string().nullable(),
});
export type ChatMessageResult = z.infer<typeof ChatMessageResultSchema>;

/** Response of `POST /memento/chats/:chat_id/seen`. */
export const ChatSeenResultSchema = z.object({
  /** `null` when the watermark did not move (nothing new was read): no event is pushed. */
  event_id: IdSchema.nullable(),
  event: EventSchema.nullable(),
  rendered: z.string().nullable(),
  advanced: z.boolean(),
  participant: ChatParticipantSchema,
});
export type ChatSeenResult = z.infer<typeof ChatSeenResultSchema>;

/** Response of `POST /memento/chats/:chat_id/participants`. */
export const ChatParticipantResultSchema = z.object({
  event_id: IdSchema,
  event: EventSchema,
  rendered: z.string().nullable(),
  participant: ChatParticipantSchema,
});
export type ChatParticipantResult = z.infer<typeof ChatParticipantResultSchema>;

/** `payload` of CHAT_MESSAGE_SENT. */
export const ChatMessageSentPayloadSchema = z.object({
  content: z.string(),
  sender_user_id: z.string(),
  timestamp: TimestampSchema,
});
export type ChatMessageSentPayload = z.infer<typeof ChatMessageSentPayloadSchema>;

/** `payload` of CHAT_MESSAGE_SEEN. */
export const ChatMessageSeenPayloadSchema = z.object({
  user_id: z.string(),
  /** Event id of the newest message read (inclusive). */
  messages_read_up_to: IdSchema,
});
export type ChatMessageSeenPayload = z.infer<typeof ChatMessageSeenPayloadSchema>;

/** `payload` of CHAT_PARTICIPANT_ADDED. */
export const ChatParticipantAddedPayloadSchema = z.object({
  user_id: z.string(),
  added_by: z.string().optional(),
});
export type ChatParticipantAddedPayload = z.infer<typeof ChatParticipantAddedPayloadSchema>;
