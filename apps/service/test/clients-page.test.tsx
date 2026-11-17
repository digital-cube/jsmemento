import CLIENTS from "virtual:clients";
import { fireEvent, screen, within } from "@testing-library/react";
import { useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceRoutes } from "../src/App.js";
import {
  CLIENTS_LANG_STORAGE_KEY,
  envLines,
  inline,
  localizePrograms,
} from "../src/pages/clients/ClientsPage.js";
import { CLIENTS_SERVICE_URL } from "../src/pages/clients/types.js";
import { fakeServer, me, renderAt, SERVED_MENU } from "./fake.js";

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname}</output>;
}

const routes = (
  <>
    <ServiceRoutes />
    <Where />
  </>
);

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("/clients", () => {
  it("is public: a tab per language, in order, the first one shown", async () => {
    renderAt(routes, fakeServer({ me: null }), "/clients");
    const langs = await screen.findByTestId("clients-langs");
    expect(
      within(langs)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["JavaScript", "TypeScript", "Python", "PHP", "Java", "Rust", "Go", "C++"]);
    expect(screen.getByTestId("where").textContent).toBe("/clients/javascript");
    expect(screen.getByTestId("clients-panel-javascript")).toBeTruthy();
    // Logged out: the header leads here, the hint to /register.
    expect((await screen.findByTestId("header-clients")).getAttribute("href")).toBe("/clients");
    const hint = screen.getByTestId("clients-env-hint");
    expect(within(hint).getByRole("link").getAttribute("href")).toBe("/register");
  });

  it("the environment block names this origin and a placeholder, and copies only that", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderAt(
      routes,
      fakeServer({ me: me(), lists: { menu: { rows: SERVED_MENU } } }),
      "/clients/golang",
    );
    const env = await screen.findByTestId("clients-env-lines");
    expect(env.textContent).toContain(`MEMENTO_URL=${location.origin}/memento`);
    expect(env.textContent).toContain("MEMENTO_API_KEY=mk_…");
    // Signed in: the hint links to the keys.
    const hint = screen.getByTestId("clients-env-hint");
    expect((await within(hint).findByRole("link")).getAttribute("href")).toBe("/keys");
    fireEvent.click(screen.getByTestId("clients-copy-env"));
    expect(writeText).toHaveBeenCalledWith(
      `MEMENTO_URL=${location.origin}/memento\nMEMENTO_API_KEY=mk_…`,
    );
    expect(envLines("https://service.example.org")).toBe(
      "MEMENTO_URL=https://service.example.org/memento\nMEMENTO_API_KEY=mk_…",
    );
  });

  it("Go: README, source with go.mod beside it, the zip; the choice is kept", async () => {
    renderAt(routes, fakeServer({ me: null }), "/clients/javascript");
    const go = await screen.findByTestId("clients-tab-golang");
    fireEvent.mouseDown(go, { button: 0 });
    const panel = await screen.findByTestId("clients-panel-golang");
    expect(screen.getByTestId("where").textContent).toBe("/clients/golang");
    expect(localStorage.getItem(CLIENTS_LANG_STORAGE_KEY)).toBe("golang");

    expect(within(panel).getByTestId("clients-readme").textContent).toContain("go run .");
    const code = within(panel).getByTestId("clients-code");
    expect(code.getAttribute("data-file")).toBe("main.go");
    expect(code.textContent).toContain("package main");
    expect(within(panel).getByTestId("clients-file-go.mod")).toBeTruthy();

    const download = within(panel).getByTestId("clients-download");
    expect(download.getAttribute("href")).toBe("/clients/golang.zip");
    expect(within(panel).getByTestId("clients-zip").textContent).toContain("golang/go.sum");
  });

  it("/clients opens the language picked last; an unknown one goes back to it", async () => {
    localStorage.setItem(CLIENTS_LANG_STORAGE_KEY, "rust");
    renderAt(routes, fakeServer({ me: null }), "/clients/cobol");
    expect(await screen.findByTestId("clients-panel-rust")).toBeTruthy();
    expect(screen.getByTestId("where").textContent).toBe("/clients/rust");
  });

  it("every program has a source on the page and no key in it", () => {
    expect(CLIENTS).toHaveLength(8);
    for (const program of CLIENTS) {
      expect(program.files[0]?.source).toBeTruthy();
      expect(program.files.map((f) => f.source).join("")).not.toMatch(/mk_[A-Za-z0-9]{8,}/);
    }
  });
});

describe("localizePrograms", () => {
  it("the sources name the production service, never stage", () => {
    const text = JSON.stringify(CLIENTS);
    expect(text).not.toContain("service.stage.");
    for (const p of CLIENTS)
      expect(p.files[0]?.source, p.id).toContain(`${CLIENTS_SERVICE_URL}/memento`);
  });

  it("names this site's origin in every source, README block and run line", () => {
    const local = localizePrograms(CLIENTS, "https://memento.test.example/");
    const text = JSON.stringify(local);
    expect(text).not.toContain(CLIENTS_SERVICE_URL);
    for (const p of local) {
      expect(p.files[0]?.source, p.id).toContain("https://memento.test.example/memento");
      expect(p.files[0]?.source, p.id).toContain("https://memento.test.example/keys");
    }
    expect(localizePrograms(CLIENTS, CLIENTS_SERVICE_URL)).toBe(CLIENTS);
  });

  it("the page shows the program with this origin", async () => {
    renderAt(routes, fakeServer({ me: null }), "/clients/python");
    const panel = await screen.findByTestId("clients-panel-python");
    expect(panel.textContent).toContain(`${location.origin}/memento`);
    expect(panel.textContent).not.toContain(CLIENTS_SERVICE_URL);
  });
});

describe("inline", () => {
  it("keeps `code` and https links of a README line", () => {
    const parts = inline("Rust via [rustup](https://rustup.rs), then `cargo run`.");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("Rust via ");
    expect(parts[4]).toBe(".");
  });
});
