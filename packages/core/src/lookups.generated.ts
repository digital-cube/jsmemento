// Generated from lookups.yaml by `memento lookups codegen`.
// Do not edit by hand: change the YAML and regenerate.
import { z } from "zod";

/** `EventTypes` from the vocabulary, as sent on the wire. */
export const EVENT_TYPES = ["USER_LOGIN", "USER_LOGOUT", "USER_CREATED", "TICKET_CREATED", "TICKET_MODIFIED", "TICKET_CLOSED", "CHAT_MESSAGE_SENT", "CHAT_MESSAGE_SEEN", "CHAT_PARTICIPANT_ADDED", "NOTE"] as const;
export enum EventType {
  USER_LOGIN = "USER_LOGIN",
  USER_LOGOUT = "USER_LOGOUT",
  USER_CREATED = "USER_CREATED",
  TICKET_CREATED = "TICKET_CREATED",
  TICKET_MODIFIED = "TICKET_MODIFIED",
  TICKET_CLOSED = "TICKET_CLOSED",
  CHAT_MESSAGE_SENT = "CHAT_MESSAGE_SENT",
  CHAT_MESSAGE_SEEN = "CHAT_MESSAGE_SEEN",
  CHAT_PARTICIPANT_ADDED = "CHAT_PARTICIPANT_ADDED",
  NOTE = "NOTE",
}
export const KnownEventTypeSchema = z.enum(EVENT_TYPES);

/** `InstanceTypes` from the vocabulary, as sent on the wire. */
export const INSTANCE_TYPES = ["user", "ticket", "chat"] as const;
export enum InstanceType {
  USER = "user",
  TICKET = "ticket",
  CHAT = "chat",
}
export const KnownInstanceTypeSchema = z.enum(INSTANCE_TYPES);

/** `ActorTypes` from the vocabulary, as sent on the wire. */
export const ACTOR_TYPES = ["user", "bot", "system"] as const;
export enum ActorType {
  USER = "user",
  BOT = "bot",
  SYSTEM = "system",
}
export const KnownActorTypeSchema = z.enum(ACTOR_TYPES);
