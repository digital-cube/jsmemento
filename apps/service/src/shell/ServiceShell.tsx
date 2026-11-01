import { useI18n, useUdcDescribe } from "@jsudc/react";
import { Button } from "@jsudc/react/ui";
import { MenuTree, RemoteMenu, TopBar } from "@memento/ui-shell";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { Link, Outlet, useNavigate } from "react-router";
import { api } from "../lib/api.js";
import { ME_KEY, type Me, useMe } from "../session.js";
import { BUILTIN_MENU_ROWS, hiddenFor, MENU_COLLECTION } from "./menu.js";

/**
 * Header and, for a signed-in user, the sidebar (the `menu` collection, read with the
 * cookie); the page of the route. Logged out there is no sidebar.
 */
export function ServiceShell() {
  const { me } = useMe();
  return (
    <div className="app">
      <TopBar>
        <Who me={me} />
      </TopBar>
      <div className="app__body">
        {me ? <Sidebar isAdmin={me.user.is_admin} /> : null}
        <main className="app__main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** The signed-in user and Log out, or Log in. */
function Who({ me }: { me: Me | null | undefined }) {
  const { t } = useI18n();
  const logOut = useLogOut();
  if (me === undefined) return null;
  if (me === null) {
    // No sidebar logged out: the public pages are in the header.
    return (
      <span className="who">
        <Link className="btn btn--ghost" to="/clients" data-testid="header-clients">
          {t("MENU", "CLIENTS")}
        </Link>
        <Link className="btn btn--ghost" to="/login" data-testid="header-login">
          {t("APP", "LOG_IN")}
        </Link>
      </span>
    );
  }
  return (
    <span className="who" data-testid="who">
      <span className="who__email">{me.user.email}</span>
      <Button variant="ghost" size="sm" onClick={logOut} data-testid="logout">
        <LogOut aria-hidden className="btn__icon" />
        {t("APP", "LOG_OUT")}
      </Button>
    </span>
  );
}

/** `POST /auth/logout`, then nobody is signed in and the visitor is on `/`. */
export function useLogOut(): () => Promise<void> {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    try {
      await api("POST", "/auth/logout");
    } finally {
      queryClient.setQueryData(ME_KEY, null);
      // Another user may sign in next: none of this one's rows may stay in the cache.
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
      navigate("/");
    }
  };
}

export function Sidebar({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useI18n();
  return (
    <nav aria-label={t("APP", "NAV_MENU")} data-testid="sidebar" className="sidebar">
      <ServedMenu isAdmin={isAdmin} />
    </nav>
  );
}

/**
 * The `menu` collection (describe gives its paging capabilities — the cookie cannot list the
 * registry's collections), the built-in rows when the server serves none.
 */
function ServedMenu({ isAdmin }: { isAdmin: boolean }) {
  const describe = useUdcDescribe(MENU_COLLECTION);
  const hidden = hiddenFor(isAdmin);
  if (describe.data) {
    return (
      <RemoteMenu
        listing={{ name: MENU_COLLECTION, capabilities: describe.data.capabilities }}
        fallback={BUILTIN_MENU_ROWS}
        hidden={hidden}
      />
    );
  }
  if (describe.isLoading) return <div className="menu__loading" data-testid="menu-loading" />;
  const rows = hidden ? BUILTIN_MENU_ROWS.filter((r) => !hidden(r)) : BUILTIN_MENU_ROWS;
  return <MenuTree rows={rows} source="builtin" />;
}
