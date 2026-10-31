import { CHAT_EVENT_TYPES, type Chat, MementoApiError, type MementoClient } from "@memento/core";

/**
 * The room `memento simulate` creates and talks in (`ROOM_ID` / `ROOM_FOUNDERS` of
 * packages/cli/src/simulate.ts). One room per tenant, a fixed id.
 */
export const ROOM_ID = "chat-demo-room";
/**
 * Who the page reads the room as first. Chat reads are made on behalf of a participant
 * (`user_id`, docs/CHATS.md), and igor is one of the founders the room is created with.
 */
export const ROOM_READER = "igor";
/** Where the chosen viewer is kept: `/examples/chat?as=ana`. */
export const VIEWER_PARAM = "as";

/** The room as `ROOM_READER` sees it, or `null` when it does not exist yet (the simulator never ran). */
export async function loadRoom(client: MementoClient): Promise<Chat | null> {
  try {
    return await client.getChat(ROOM_ID, { user_id: ROOM_READER });
  } catch (error) {
    if (error instanceof MementoApiError && error.status === 404) return null;
    throw error;
  }
}

/** Participant ids in the order the room lists them. */
export function participantIds(room: Chat | null | undefined): string[] {
  return room ? room.participants.map((p) => p.user_id) : [];
}

/** The viewer: the one asked for when they are in the room, else the first participant. */
export function chooseViewer(ids: readonly string[], asked: string | null): string | null {
  if (asked && ids.includes(asked)) return asked;
  return ids[0] ?? null;
}

/**
 * Does a stream event of the room change what the page shows around the chat (the room's
 * existence, its participants)? Messages and read markers are `MementoChat`'s own business.
 */
export function changesRoom(eventType: string, roomKnown: boolean): boolean {
  return !roomKnown || eventType === CHAT_EVENT_TYPES.participantAdded;
}
