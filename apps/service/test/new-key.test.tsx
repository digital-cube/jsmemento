import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { envLines, newKeyBlock, newKeyBody } from "../src/keys/keys.js";
import { NewKeyDialog } from "../src/keys/NewKeyDialog.js";
import { fail, fakeServer, me, ok, renderAt } from "./fake.js";

afterEach(() => vi.unstubAllGlobals());

const KEY = "mk_abcd1234_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

function open(server: ReturnType<typeof fakeServer>, onClosed = vi.fn()) {
  renderAt(
    <NewKeyDialog open limits={me().limits} onClosed={onClosed} origin="https://service.example" />,
    server,
  );
  return onClosed;
}

describe("the New key dialog", () => {
  it("creates the key and shows it once, with the two lines the clients read", async () => {
    const server = fakeServer({
      routes: {
        "POST /keys": () =>
          ok(
            {
              api_key: { id: "k1", name: "backend", prefix: "abcd1234", scopes: ["read", "write"] },
              key: KEY,
            },
            201,
          ),
      },
    });
    const onClosed = open(server);
    expect((screen.getByTestId("new-key-limit") as HTMLInputElement).value).toBe("100000");
    fireEvent.change(screen.getByTestId("new-key-name"), { target: { value: " backend " } });
    fireEvent.click(screen.getByTestId("new-key-read"));
    fireEvent.change(screen.getByTestId("new-key-expires"), { target: { value: "2027-01-31" } });
    fireEvent.click(screen.getByTestId("new-key-submit"));

    const once = await screen.findByTestId("once-view");
    expect(screen.getByTestId("once-key").textContent).toBe(KEY);
    expect(once.textContent).toContain(
      "This key is shown only now. Copy it; it cannot be shown again.",
    );
    expect(screen.getByTestId("once-env").textContent).toBe(
      `MEMENTO_URL=https://service.example/memento\nMEMENTO_API_KEY=${KEY}`,
    );
    expect(within(once).getByTestId("copy-key")).toBeTruthy();
    expect(within(once).getByTestId("copy-env")).toBeTruthy();
    const post = server.calls.find((c) => c.path === "/keys");
    expect(post?.body).toEqual({
      name: "backend",
      scopes: ["write"],
      expires_at: "2027-01-31T23:59:59Z",
      daily_limit: 100000,
    });
    expect(post?.credentials).toBe("include");

    fireEvent.click(screen.getByTestId("once-done"));
    expect(onClosed).toHaveBeenCalledWith(true);
  });

  it("copies the key", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const server = fakeServer({
      routes: { "POST /keys": () => ok({ api_key: { id: "k1" }, key: KEY }, 201) },
    });
    open(server);
    fireEvent.change(screen.getByTestId("new-key-name"), { target: { value: "backend" } });
    fireEvent.click(screen.getByTestId("new-key-submit"));
    fireEvent.click(await screen.findByTestId("copy-key"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(KEY));
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("needs a name and a scope, and a limit within the ceiling, before it asks the server", async () => {
    const server = fakeServer();
    open(server);
    fireEvent.click(screen.getByTestId("new-key-read"));
    fireEvent.click(screen.getByTestId("new-key-write"));
    fireEvent.change(screen.getByTestId("new-key-limit"), { target: { value: "600000" } });
    fireEvent.click(screen.getByTestId("new-key-submit"));
    expect(await screen.findByText("Required")).toBeTruthy();
    expect(screen.getByText("Pick at least one scope")).toBeTruthy();
    expect(screen.getByText("Between 1 and 500000")).toBeTruthy();
    expect(server.calls.some((c) => c.path === "/keys")).toBe(false);
  });

  it("shows the server's refusal and stays on the form", async () => {
    const server = fakeServer({
      routes: {
        "POST /keys": () =>
          fail(409, "limit_reached", "this account may hold 10 API keys: delete one first"),
      },
    });
    const onClosed = open(server);
    fireEvent.change(screen.getByTestId("new-key-name"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("new-key-submit"));
    expect(await screen.findByText(/may hold 10 API keys/)).toBeTruthy();
    expect(screen.queryByTestId("once-view")).toBeNull();
    expect(onClosed).not.toHaveBeenCalled();
  });
});

describe("key helpers", () => {
  it("newKeyBody: no expiry and an empty limit send neither", () => {
    expect(
      newKeyBody({ name: "a", read: true, write: false, expires: "", dailyLimit: "" }, null),
    ).toEqual({ ok: true, body: { name: "a", scopes: ["read"] } });
    expect(
      newKeyBody({ name: "a", read: true, write: true, expires: "", dailyLimit: "1.5" }, null),
    ).toEqual({ ok: false, errors: { daily_limit: "LIMIT_POSITIVE" } });
  });

  it("newKeyBlock: unverified first, then the key ceiling", () => {
    expect(newKeyBlock(false, 0, 10)).toBe("unverified");
    expect(newKeyBlock(true, 10, 10)).toBe("max");
    expect(newKeyBlock(true, 9, 10)).toBeNull();
    expect(newKeyBlock(true, null, 10)).toBeNull();
  });

  it("envLines keeps an absolute API base", () => {
    expect(envLines("https://a.example/", "/memento", "k")).toBe(
      "MEMENTO_URL=https://a.example/memento\nMEMENTO_API_KEY=k",
    );
    expect(envLines("https://a.example", "https://api.example/m", "k")).toContain(
      "MEMENTO_URL=https://api.example/m",
    );
  });
});
