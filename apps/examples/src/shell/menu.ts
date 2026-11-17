import { menuRow } from "@jsmemento/ui-shell";
import type { Row } from "@jsudc/core";

// The menu's pure parts (buildMenu, activeLeaf, the expand state) are @jsmemento/ui-shell's.

/**
 * The sidebar when the server serves no `menu` collection (no menu.yaml, no key yet, an
 * error): HOME and EXAMPLES of the repository's menu.yaml (every example, in its order), so
 * the site never renders empty.
 */
export const BUILTIN_MENU_ROWS: readonly Row[] = [
  menuRow("HOME", 0, { translation_key: "MENU_HOME", icon: "lucide:house", url: "/" }),
  menuRow("EXAMPLES", 1, {
    translation_key: "MENU_EXAMPLES",
    icon: "lucide:layout-dashboard",
    children_count: 8,
  }),
  menuRow("EXAMPLES/CPU_MONITOR", 0, {
    translation_key: "MENU_CPU_MONITOR",
    icon: "lucide:activity",
    url: "/examples/cpu-monitor",
  }),
  menuRow("EXAMPLES/ACTIVITY", 1, {
    translation_key: "MENU_ACTIVITY",
    icon: "lucide:file-text",
    url: "/examples/activity",
  }),
  menuRow("EXAMPLES/ENTITY", 2, {
    translation_key: "MENU_ENTITY",
    icon: "lucide:folder-open",
    url: "/examples/entity",
  }),
  menuRow("EXAMPLES/CHAT", 3, {
    translation_key: "MENU_CHAT",
    icon: "lucide:messages-square",
    url: "/examples/chat",
  }),
  menuRow("EXAMPLES/TAIL", 4, {
    translation_key: "MENU_TAIL",
    icon: "lucide:network",
    url: "/examples/tail",
  }),
  menuRow("EXAMPLES/SEARCH", 5, {
    translation_key: "MENU_SEARCH",
    icon: "lucide:database",
    url: "/examples/search",
  }),
  menuRow("EXAMPLES/RENDERING", 6, {
    translation_key: "MENU_RENDERING",
    icon: "lucide:globe",
    url: "/examples/rendering",
  }),
  menuRow("EXAMPLES/CHART", 7, {
    translation_key: "MENU_CHART",
    icon: "lucide:chart-line",
    url: "/examples/chart",
  }),
];
