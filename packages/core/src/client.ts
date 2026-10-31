import type { Chat, ChatMessageResult } from "./chat.js";
import { chatInstanceId } from "./chat.js";
import type { PageMeta } from "./envelope.js";
import type { MementoEvent } from "./event.js";
import type { EventQueryInput } from "./query.js";

/** A failed API call: the server's error envelope, or `network_error` when there was none. */
export class MementoApiError extends Error {
  override readonly name = "MementoApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export interface MementoClientOptions {
  /** API base URL, e.g. `http://localhost:8000/memento` (or `/memento` in a browser). */
  baseUrl: string;
  apiKey: string;
  /** Default: `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export interface Page<T> {
  data: T;
  meta: PageMeta;
}

type QueryValue = string | number | boolean | undefined | null;

/** A typed wrapper around the HTTP API (the endpoints a UI or the CLI reads and writes). */
export class MementoClient {
  readonly baseUrl: string;
  readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MementoClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  /** `GET /events`: filters accept a trailing `*`; newest first unless `order: "asc"`. */
  listEvents(query: EventQueryInput = {}): Promise<Page<MementoEvent[]>> {
    return this.request("GET", "/events", { query: query as Record<string, QueryValue> });
  }

  /** `GET /chats/:id/messages` (oldest first by default here, the way a chat reads). */
  chatMessages(
    chatId: string,
    query: {
      user_id?: string;
      limit?: number;
      offset?: number;
      order?: "asc" | "desc";
      locale?: string;
    } = {},
  ): Promise<Page<MementoEvent[]>> {
    return this.request("GET", `/chats/${encodeURIComponent(chatInstanceId(chatId))}/messages`, {
      query: { order: "asc", ...query },
    });
  }

  async getChat(chatId: string, query: { user_id?: string } = {}): Promise<Chat> {
    const page = await this.request<Chat>(
      "GET",
      `/chats/${encodeURIComponent(chatInstanceId(chatId))}`,
      { query },
    );
    return page.data;
  }

  async sendMessage(
    chatId: string,
    message: { user_id: string; content: string },
    options: { locale?: string } = {},
  ): Promise<ChatMessageResult> {
    const page = await this.request<ChatMessageResult>(
      "POST",
      `/chats/${encodeURIComponent(chatInstanceId(chatId))}/messages`,
      { query: { locale: options.locale }, body: message },
    );
    return page.data;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    options: { query?: Record<string, QueryValue>; body?: unknown } = {},
  ): Promise<Page<T>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    }
    const search = params.size > 0 ? `?${params}` : "";
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}` };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}${search}`, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (error) {
      throw new MementoApiError(
        0,
        "network_error",
        `cannot reach ${this.baseUrl}: ${(error as Error).message}`,
      );
    }
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      data?: T;
      meta?: PageMeta;
      error?: { code: string; message: string; details?: unknown };
      request_id?: string;
    } | null;
    if (!response.ok || !body?.ok) {
      throw new MementoApiError(
        response.status,
        body?.error?.code ?? "bad_response",
        body?.error?.message ?? `HTTP ${response.status}`,
        body?.error?.details,
        body?.request_id,
      );
    }
    return {
      data: body.data as T,
      meta: body.meta ?? { limit: 0, count: 0, next_cursor: null },
    };
  }
}
