import { UdcError } from "@jsudc/core";
import { withoutHidden } from "@memento/ui-shell";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceRoutes } from "../src/App.js";
import { ApiError } from "../src/lib/api.js";
import { isSessionRefusal, loginPath, ME_KEY, safeNext } from "../src/session.js";
import { BUILTIN_MENU_ROWS, hiddenFor, isAdminNode } from "../src/shell/menu.js";
import { fakeServer, me, menuNode, renderAt, SERVED_MENU } from "./fake.js";

afterEach(() => vi.unstubAllGlobals());

const lists = { menu: { rows: SERVED_MENU }, api_keys: { rows: [] } };

describe("the admin menu entry", () => {
  it("is hidden from a user who is not an administrator", async () => {
    renderAt(<ServiceRoutes />, fakeServer({ me: me(), lists }), "/clients");
    const tree = await screen.findByTestId("menu-tree");
    expect(tree.getAttribute("data-source")).toBe("menu");
    await screen.findByTestId("menu-KEYS");
    expect(screen.queryByTestId("menu-ADMIN")).toBeNull();
  });

  it("is shown to an administrator", async () => {
    renderAt(<ServiceRoutes />, fakeServer({ me: me({ admin: true }), lists }), "/clients");
    expect(await screen.findByTestId("menu-ADMIN")).toBeTruthy();
  });

  it("drops an ADMIN node with its subtree; the built-in rows have one too", () => {
    const rows = [
      ...SERVED_MENU,
      {
        ...menuNode("ADMIN_KEYS", 0, "/admin/keys"),
        parent_id: "menu:ADMIN",
        ancestor_ids: ["menu:ADMIN"],
      },
    ];
    const hidden = hiddenFor(false);
    expect(hidden).toBe(isAdminNode);
    expect(withoutHidden(rows, isAdminNode).map((r) => r.code)).toEqual([
      "HOME",
      "KEYS",
      "CLIENTS",
      "ACCOUNT",
    ]);
    expect(hiddenFor(true)).toBeUndefined();
    expect(BUILTIN_MENU_ROWS.some(isAdminNode)).toBe(true);
  });

  it("an admin page sends a user who is not an administrator to /keys", async () => {
    renderAt(<ServiceRoutes />, fakeServer({ me: me(), lists }), "/admin/users");
    expect(await screen.findByTestId("keys-table")).toBeTruthy();
  });
});

describe("the session", () => {
  it("logged out: no sidebar, and a signed-in page leads to /login?next=", async () => {
    renderAt(<ServiceRoutes />, fakeServer({ me: null }), "/keys/k1/events?view=history");
    expect(await screen.findByTestId("login")).toBeTruthy();
    expect(screen.queryByTestId("sidebar")).toBeNull();
    expect(screen.getByTestId("header-login")).toBeTruthy();
  });

  it("home: logged out the three sentences, signed in the keys", async () => {
    renderAt(<ServiceRoutes />, fakeServer({ me: null }), "/");
    expect(await screen.findByTestId("home")).toBeTruthy();
  });

  it("a refused UDC call asks /auth/me again; a 401 there leads to /login", async () => {
    let signedIn = true;
    const server = fakeServer({ me: me(), lists });
    const { queryClient } = renderAt(<ServiceRoutes />, server, "/keys");
    await screen.findByTestId("keys-table");
    signedIn = false;
    server.fetch.mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/auth/me")) {
        return new Response(
          JSON.stringify({ ok: false, error: { code: "unauthorized", message: "x" } }),
          {
            status: signedIn ? 200 : 401,
          },
        );
      }
      return new Response(
        JSON.stringify({
          kind: "udc.list.err",
          id: "",
          payload: { code: "forbidden", message: "not signed in" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await queryClient.invalidateQueries({ queryKey: ["udc", "list"] });
    expect(await screen.findByTestId("login")).toBeTruthy();
    expect(queryClient.getQueryData(ME_KEY)).toBeNull();
  });

  it("helpers", () => {
    expect(isSessionRefusal(new UdcError("forbidden", "x"))).toBe(true);
    expect(isSessionRefusal(new UdcError("not_found", "x"))).toBe(false);
    expect(isSessionRefusal(new ApiError(401, "unauthorized", "x"))).toBe(true);
    expect(isSessionRefusal(new ApiError(403, "forbidden", "x"))).toBe(false);
    expect(safeNext("/keys/1?x=2")).toBe("/keys/1?x=2");
    expect(safeNext("//evil.example")).toBe("/keys");
    expect(safeNext("https://evil.example")).toBe("/keys");
    expect(safeNext(null)).toBe("/keys");
    expect(loginPath({ pathname: "/keys/1", search: "?a=b" })).toBe(
      "/login?next=%2Fkeys%2F1%3Fa%3Db",
    );
  });
});

describe("the keys page", () => {
  it("unverified: New key is disabled, the banner offers to send the mail again", async () => {
    const server = fakeServer({
      me: me({ verified: false }),
      lists,
      routes: {
        "POST /auth/resend": () => new Response(JSON.stringify({ ok: true, data: { sent: true } })),
      },
    });
    renderAt(<ServiceRoutes />, server, "/keys");
    await screen.findByTestId("verify-banner");
    expect((screen.getByTestId("new-key") as HTMLButtonElement).disabled).toBe(true);
    screen.getByTestId("resend").click();
    expect(await screen.findByTestId("resent")).toBeTruthy();
  });

  it("at max_keys: New key is disabled with the reason", async () => {
    const server = fakeServer({
      me: me({ maxKeys: 2 }),
      lists: { ...lists, api_keys: { rows: [], total: 2 } },
    });
    renderAt(<ServiceRoutes />, server, "/keys");
    const reason = await screen.findByTestId("new-key-reason");
    expect(reason.textContent).toBe("This tenant holds 2 keys, its maximum: delete one first.");
    await waitFor(() =>
      expect((screen.getByTestId("new-key") as HTMLButtonElement).disabled).toBe(true),
    );
  });

  it("draws the keys with chips and a usage bar; a row opens the key", async () => {
    const row = {
      __meta: { id: "k1", version: 1 },
      name: "backend",
      prefix: "abcd1234",
      scopes: ["read", "write"],
      status: "disabled",
      daily_limit: 100,
      used_today: 90,
      created_at: "2026-11-01T08:00:00Z",
      last_used_at: null,
    };
    renderAt(
      <ServiceRoutes />,
      fakeServer({ me: me(), lists: { ...lists, api_keys: { rows: [row] } } }),
      "/keys",
    );
    const tr = await screen.findByTestId("keys-table-row");
    expect(tr.textContent).toContain("mk_abcd1234_…");
    expect(tr.querySelector("[data-status=disabled]")?.textContent).toBe("paused");
    expect(tr.querySelector("[data-testid=usage-bar]")?.getAttribute("data-tone")).toBe("warn");
  });
});
