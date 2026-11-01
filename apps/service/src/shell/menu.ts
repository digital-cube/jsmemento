import type { Row } from "@jsudc/core";
import { menuRow } from "@memento/ui-shell";

/** The collection the sidebar is drawn from (menu-service.yaml on the service instance). */
export const MENU_COLLECTION = "menu";

/**
 * The sidebar when the server serves no `menu` collection (or it cannot be read): the entries
 * of menu-service.yaml, so the site never renders without its way around.
 */
export const BUILTIN_MENU_ROWS: readonly Row[] = [
  menuRow("HOME", 0, { translation_key: "MENU_HOME", icon: "lucide:house", url: "/" }),
  menuRow("KEYS", 1, { translation_key: "MENU_KEYS", icon: "lucide:database", url: "/keys" }),
  menuRow("CLIENTS", 2, {
    translation_key: "MENU_CLIENTS",
    icon: "lucide:layout-grid",
    url: "/clients",
  }),
  menuRow("ACCOUNT", 3, { translation_key: "MENU_ACCOUNT", icon: "lucide:info", url: "/account" }),
  menuRow("ADMIN", 4, {
    translation_key: "MENU_ADMIN",
    icon: "lucide:network",
    url: "/admin/users",
  }),
];

/** A node only administrators see: its `code` starts with `ADMIN`. */
export function isAdminNode(row: Row): boolean {
  return typeof row.code === "string" && row.code.startsWith("ADMIN");
}

/** What the sidebar hides from this user: the admin nodes, unless they are an administrator. */
export function hiddenFor(isAdmin: boolean): ((row: Row) => boolean) | undefined {
  return isAdmin ? undefined : isAdminNode;
}
