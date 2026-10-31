import { LocaleSchema, ok } from "@memento/core";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { RouteDeps } from "../app.js";
import { MementoError } from "../errors.js";
import {
  addParticipant,
  createChat,
  getChat,
  listChatMessages,
  listChats,
  markSeen,
  sendMessage,
} from "../services/chats.js";
import type { PushOptions } from "../services/events.js";

type ChatParams = { Params: { chat_id: string } };

const PushQuerySchema = z.looseObject({ locale: LocaleSchema.optional() });
const ViewerQuerySchema = z.looseObject({ user_id: z.string().trim().min(1).max(200).optional() });

/**
 * Chats: `chat-<id>` instances whose messages, read markers and joins are ordinary
 * events. Every call names the user it acts for, who must be a participant.
 */
export const chatRoutes: FastifyPluginAsync<RouteDeps> = async (
  app,
  { db, publisher, renderer, lookups },
) => {
  const pushOptions = (request: {
    query: unknown;
    log: { warn: (o: object, m: string) => void };
  }) => {
    const query = PushQuerySchema.safeParse(request.query ?? {});
    if (!query.success) {
      throw new MementoError("validation_error", "invalid locale", query.error.issues);
    }
    const options: PushOptions = {
      publisher,
      renderer,
      lookups,
      onPublishError: (error) =>
        request.log.warn({ err: error }, "event stored but publishing to Redis failed"),
    };
    if (query.data.locale) options.locale = query.data.locale;
    return options;
  };

  /** Create a chat: `{ participants, name?, kind?, chat_id? }`. */
  app.post("/chats", { config: { scope: "write" } }, async (request, reply) => {
    const chat = await createChat(db, request.body as never);
    request.log.info({ chat_id: chat.chat_id, kind: chat.kind }, "chat created");
    return reply.status(201).send(ok(chat));
  });

  /** Chats `?user_id=` participates in, most recently active first. */
  app.get("/chats", { config: { scope: "read" } }, async (request) => {
    const page = await listChats(db, request.query as Record<string, unknown>);
    return ok(page.chats, page.meta);
  });

  app.get<ChatParams>("/chats/:chat_id", { config: { scope: "read" } }, async (request) => {
    const query = ViewerQuerySchema.safeParse(request.query ?? {});
    if (!query.success) {
      throw new MementoError("validation_error", "invalid query", query.error.issues);
    }
    return ok(await getChat(db, request.params.chat_id, query.data.user_id));
  });

  /** Send a message: `{ content, user_id, occurred_at? }` → CHAT_MESSAGE_SENT. */
  app.post<ChatParams>(
    "/chats/:chat_id/messages",
    { config: { scope: "write" } },
    async (request, reply) => {
      const result = await sendMessage(
        db,
        request.params.chat_id,
        request.body as never,
        pushOptions(request),
      );
      request.log.info(
        { event_id: result.event_id, chat_id: request.params.chat_id },
        "message sent",
      );
      return reply.status(201).send(ok(result));
    },
  );

  /** A chat's messages: `?user_id&limit&offset&order&event_type&locale`. */
  app.get<ChatParams>(
    "/chats/:chat_id/messages",
    { config: { scope: "read" } },
    async (request) => {
      const page = await listChatMessages(
        db,
        request.params.chat_id,
        request.query as Record<string, unknown>,
        { renderer },
      );
      return ok(page.events, page.meta);
    },
  );

  /** Mark as seen: `{ user_id, up_to_event_id? }` → CHAT_MESSAGE_SEEN (when it advances). */
  app.post<ChatParams>("/chats/:chat_id/seen", { config: { scope: "write" } }, async (request) =>
    ok(await markSeen(db, request.params.chat_id, request.body as never, pushOptions(request))),
  );

  /** Add a room member: `{ user_id, added_by? }` → CHAT_PARTICIPANT_ADDED. */
  app.post<ChatParams>(
    "/chats/:chat_id/participants",
    { config: { scope: "write" } },
    async (request, reply) => {
      const result = await addParticipant(
        db,
        request.params.chat_id,
        request.body as never,
        pushOptions(request),
      );
      return reply.status(201).send(ok(result));
    },
  );
};
