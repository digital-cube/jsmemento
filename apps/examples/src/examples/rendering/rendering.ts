import type { FilterNode, Row, SortKey } from "@jsudc/core";
import type { UdcClient } from "@jsudc/core/client";
import { udcKeys } from "@jsudc/react";
import type { TemplateLocale } from "./templates.js";

/**
 * The Rendering page's data: the latest event of a type, read from the `events` UDC
 * collection, and that same event read once per locale (`X-Memento-Locale: en | sr`) — the
 * sentences are memento's, rendered on the server, not a Handlebars run in the browser.
 */
export const RENDERING_COLLECTION = "events";
export const LATEST_SORT: SortKey[] = [{ field: "occurred_at", dir: "desc" }];

/** Where the page shows `type`. */
export function renderingPath(type: string): string {
  return `/examples/rendering?type=${encodeURIComponent(type)}`;
}

/** The events of one type (exact). */
export function typeFilter(type: string): FilterNode {
  return { field: "event_type", op: "eq", value: type };
}

/** The query keys, under the collection's lists: a stream refresh or a language switch refetches them. */
export const renderingKeys = {
  latest: (type: string) => [...udcKeys.lists(RENDERING_COLLECTION), "rendering", "latest", type],
  rendered: (id: string, locale: TemplateLocale) => [
    ...udcKeys.lists(RENDERING_COLLECTION),
    "rendering",
    "read",
    id,
    locale,
  ],
};

/** The newest event of `type`, or `null` when the tenant has none. */
export async function latestEvent(client: UdcClient, type: string): Promise<Row | null> {
  const { rows } = await client.list({
    collection: RENDERING_COLLECTION,
    filter: typeFilter(type),
    sort: LATEST_SORT,
    page: { limit: 1 },
  });
  return rows[0] ?? null;
}

/**
 * The text memento renders for event `id`, asked of a client whose `X-Memento-Locale` is the
 * locale wanted (`mementoUdcClient(…, locale)`).
 */
export async function renderedIn(client: UdcClient, id: string): Promise<string | null> {
  const { row } = await client.read(RENDERING_COLLECTION, id);
  return typeof row.rendered === "string" ? row.rendered : null;
}

/** A field of a row as text, or `null`. */
export function text(row: Row | null | undefined, field: string): string | null {
  const v = row?.[field];
  return typeof v === "string" && v !== "" ? v : null;
}
