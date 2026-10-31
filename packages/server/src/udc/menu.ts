import { fileURLToPath } from "node:url";
import { sourceGroup, type ViewConfigInput, ViewConfigSchema } from "@jsudc/core";
import { type Collection, type CollectionRegistry, YamlMenuSource } from "@jsudc/server";

/** `menu.yaml` at the repository root, next to `lookups.yaml` (same depth from `src/` and `dist/`). */
export const DEFAULT_MENU_PATH = fileURLToPath(new URL("../../../../menu.yaml", import.meta.url));

/** The UDC collection the examples site draws its sidebar from. */
export const MENU_COLLECTION = "menu";

/** The icon of each collection's node in the `udc:collections` branch; the rest get `lucide:table`. */
export const MENU_COLLECTION_ICONS: Record<string, string> = {
  events: "lucide:database",
  cpu_load: "lucide:chart-line",
  menu: "lucide:list-tree",
};

/** The menu as data (`/udc/menu`): a tree, and a table of the flat rows. */
export const MENU_VIEW: ViewConfigInput = {
  default_renderer: "table",
  available_renderers: ["table"],
  pagination: "infinite",
  page_size_default: 200,
  columns: [
    { field: "icon", render: "icon", width: 56, align: "center" },
    { field: "translation_key", width: 220 },
    { field: "code", width: 200 },
    { field: "url", width: 240 },
    { field: "order", align: "right", width: 80 },
    { field: "depth", align: "right", width: 80 },
    { field: "children_count", align: "right", width: 130 },
    { field: "is_dynamic", render: "bool", align: "center", width: 110 },
  ],
  search: { fields: ["translation_key", "code", "url"] },
};

export interface MenuCollectionOptions {
  /** The menu YAML (absolute). It must exist: a missing or invalid file throws here. */
  file: string;
  /** The registry the `udc:collections` branch lists, asked again on every read. */
  registry: CollectionRegistry;
}

/**
 * The `menu` collection: a YAML file served as flat tree rows by `@jsudc/server`'s
 * `yaml_menu` source, `dynamic`, so `children: "udc:collections"` lists the registry's
 * collections live (this one included). Not tenant data: the source never reads the tenant,
 * every key with the `read` scope sees the same menu.
 */
export function menuCollection({ file, registry }: MenuCollectionOptions): Collection {
  return {
    name: MENU_COLLECTION,
    label: "Menu",
    source: new YamlMenuSource({
      file,
      displayPath: "menu.yaml",
      dynamic: true,
      collectionIcons: MENU_COLLECTION_ICONS,
      collections: () =>
        registry
          .list()
          .map((c) => ({ name: c.name, group: sourceGroup(c.source.kind ?? "postgres_jsonb") })),
    }),
    view: ViewConfigSchema.parse(MENU_VIEW),
  };
}
