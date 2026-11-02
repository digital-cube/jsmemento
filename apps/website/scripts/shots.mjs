#!/usr/bin/env node
/**
 *   npm run shots [-- <name> ...]
 *
 * The home page's "The examples, live": one screenshot per page of the examples site, the
 * whole window (its sidebar and header are part of the point), written as
 * src/assets/examples/<name>-<theme>.webp. The site imports the files, so a build after this
 * picks them up. Re-run it when an example's look changes; the webp files are committed.
 *
 * Themes. The examples site follows @jsudc/react's theme: `html.dark` when localStorage
 * `udc-theme` is "dark" (ThemeProvider, THEME_STORAGE_KEY). @memento/ui-shell has no dark
 * tokens and the site mounts no ThemeProvider yet, so today a dark shot would be the light one:
 * THEMES is ["light"] and the home page shows the light shot in both of its own themes. Once
 * the examples site has a dark theme, add "dark" here and run this again; the component picks
 * up <name>-dark.webp by itself.
 *
 * SHOTS_BASE     the examples site to shoot (default EXAMPLE_URL from src/site.mjs)
 * SHOTS_SCALE    device pixel ratio (default 2)
 * SHOTS_CHANNEL  a browser Playwright did not download, e.g. `chrome` (default: Playwright's
 *                own Chromium, `npx playwright install chromium` once)
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";
import { EXAMPLE_URL } from "../src/site.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "assets", "examples");
const BASE = (process.env.SHOTS_BASE || EXAMPLE_URL).replace(/\/$/, "");
const SCALE = Number(process.env.SHOTS_SCALE || 2);
const VIEWPORT = { width: 1280, height: 800 };
const THEMES = ["light"];

/**
 * One entry per page, in the order of menu.yaml. `prepare` runs on the loaded page before the
 * shot; `settle` is how long the page gets after that (live pages need a few events).
 */
const SHOTS = [
  { name: "cpu-monitor", path: "/examples/cpu-monitor", settle: 4000 },
  { name: "activity", path: "/examples/activity", settle: 2500 },
  {
    name: "entity",
    path: "/examples/entity?type=ticket",
    // The picker lists the most recently active tickets; open the first one's timeline.
    prepare: async (page) => {
      const first = page.locator('main a[href*="/examples/entity/ticket/"]').first();
      await first.waitFor({ timeout: 15_000 });
      await first.click();
      await page.waitForURL(/\/examples\/entity\/ticket\//);
      await page.waitForLoadState("networkidle");
    },
    settle: 2000,
  },
  { name: "chat", path: "/examples/chat?as=ana", settle: 2500 },
  // The stream starts empty: give it a few frames of the simulator and the CPU monitor.
  { name: "tail", path: "/examples/tail", settle: 8000 },
  { name: "search", path: "/examples/search?type=ticket", settle: 2000 },
  { name: "rendering", path: "/examples/rendering?type=TICKET_CLOSED", settle: 2000 },
  { name: "chart", path: "/examples/chart?w=1h", settle: 3000 },
];

const only = process.argv.slice(2);
const shots = only.length ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;
if (only.length && shots.length !== only.length) {
  console.error(`unknown shot; known: ${SHOTS.map((s) => s.name).join(", ")}`);
  process.exit(2);
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ channel: process.env.SHOTS_CHANNEL || undefined });
try {
  for (const theme of THEMES) {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      colorScheme: theme,
      locale: "en-GB",
      timezoneId: "Europe/Belgrade",
    });
    // Theme and language live in localStorage (@jsudc/react's THEME_STORAGE_KEY and
    // LOCALE_STORAGE_KEY); set both before any of the site's scripts run.
    await context.addInitScript((t) => {
      localStorage.setItem("udc-theme", t);
      localStorage.setItem("udc-locale", "en");
    }, theme);
    const page = await context.newPage();
    for (const shot of shots) {
      await page.goto(BASE + shot.path, { waitUntil: "networkidle" });
      await page.locator("main").waitFor();
      // Skeletons gone = the first page of rows has drawn.
      await page
        .locator(".udc-skeleton")
        .first()
        .waitFor({ state: "detached", timeout: 15_000 })
        .catch(() => {});
      if (shot.prepare) await shot.prepare(page);
      await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.blur());
      await page.mouse.move(0, VIEWPORT.height - 1);
      await page.waitForTimeout(shot.settle ?? 1000);
      const png = await page.screenshot({ animations: "disabled", caret: "hide" });
      await sharp(png)
        .webp({ quality: 82 })
        .toFile(join(OUT, `${shot.name}-${theme}.webp`));
      console.log(`${theme.padEnd(5)} ${shot.name.padEnd(12)} ${page.url()}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
