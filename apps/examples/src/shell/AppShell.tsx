import { useI18n, useUdcCollections } from "@jsudc/react";
import { Segmented, Spinner } from "@jsudc/react/ui";
import type { ReactNode } from "react";
import { Outlet } from "react-router";
import { useSettings } from "../connection.js";
import { MENU_COLLECTION, MenuTree, RemoteMenu } from "./MenuTree.js";
import { BUILTIN_MENU_ROWS } from "./menu.js";
import { ConnectionForm, KeyBadge, SettingsPopover } from "./Settings.js";

/** Header, sidebar (the menu collection), and the page of the route. */
export function AppShell() {
  return (
    <div className="app">
      <TopBar />
      <div className="app__body">
        <Sidebar />
        <main className="app__main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function TopBar() {
  const { t, locale, locales, setLocale } = useI18n();
  const { connection } = useSettings();
  return (
    <header className="topbar">
      <div className="brand" data-testid="app-name">
        <span className="brand__mark">{t("APP", "NAME")}</span>
        <span className="brand__sub">{t("APP", "TAGLINE")}</span>
      </div>
      <div className="topbar__tools">
        <KeyBadge connection={connection} />
        <Segmented
          aria-label={t("APP", "LANGUAGE")}
          data-testid="locale-switch"
          value={locale}
          onChange={setLocale}
          options={locales.map((l) => ({
            value: l,
            label: l.toUpperCase(),
            testId: `locale-${l}`,
          }))}
        />
        <SettingsPopover />
      </div>
    </header>
  );
}

/**
 * The sidebar: the `menu` collection (`VITE_MENU_COLLECTION`) drawn as a tree when the
 * server serves one; the built-in HOME and EXAMPLES entries without a key, without the
 * collection or when the server cannot be asked.
 */
function Sidebar() {
  const { t } = useI18n();
  const { connection } = useSettings();
  return (
    <nav aria-label={t("APP", "NAV_MENU")} data-testid="sidebar" className="sidebar">
      {connection.apiKey ? <ServedMenu /> : <MenuTree rows={BUILTIN_MENU_ROWS} source="builtin" />}
    </nav>
  );
}

function ServedMenu() {
  const collections = useUdcCollections();
  const menu = collections.data?.collections.find((c) => c.name === MENU_COLLECTION);
  if (menu) return <RemoteMenu listing={menu} />;
  if (collections.isLoading) return <div className="menu__loading" data-testid="menu-loading" />;
  return <MenuTree rows={BUILTIN_MENU_ROWS} source="builtin" />;
}

/**
 * A page that talks to the server: its content once there is a key (the visitor's own or
 * the demo key), a spinner while the demo key is being asked for, the connection form and
 * the "Paste an API key" hint when there is neither.
 */
export function Connected({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { connection } = useSettings();
  if (connection.apiKey) return <>{children}</>;
  if (connection.source === "pending") {
    return (
      <div className="page__center" data-testid="connecting">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="hint">
      <p>{t("APP", "NO_KEY")}</p>
      <ConnectionForm />
    </div>
  );
}
