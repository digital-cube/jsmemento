// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";
import { SITE_URL } from "./src/site.mjs";

/* The hero's placeholders for the other memento sites (src/components/Hero.astro resolves them
   from src/site.mjs, which frontmatter cannot import). */
const PLACEHOLDERS = new Set(["{EXAMPLE_URL}", "{SERVICE_URL}"]);

export default defineConfig({
  site: SITE_URL,
  integrations: [
    starlight({
      title: "memento",
      description:
        "A self-hosted activity ledger: applications push machine events, memento keeps them immutable and tenant-isolated and serves them back per entity, per actor, as a feed, as a live stream, as sentences in the reader's language.",
      favicon: "/favicon.svg",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/digital-cube/jsmemento",
        },
      ],
      components: {
        Hero: "./src/components/Hero.astro",
        SiteTitle: "./src/components/SiteTitle.astro",
      },
      expressiveCode: {
        themes: ["github-dark-default", "github-light-default"],
        defaultProps: { wrap: true, preserveIndent: true },
        styleOverrides: {
          borderRadius: "4px",
          borderColor: "var(--sl-color-hairline-light)",
          codeFontFamily: "var(--sl-font-mono)",
          codeFontSize: "0.8125rem",
          codeLineHeight: "1.7",
          frames: { shadowColor: "transparent" },
        },
      },
      customCss: [
        "@fontsource-variable/bodoni-moda/opsz.css",
        "@fontsource-variable/bodoni-moda/opsz-italic.css",
        "@fontsource-variable/instrument-sans/wght.css",
        "@fontsource/ibm-plex-mono/400.css",
        "@fontsource/ibm-plex-mono/500.css",
        "./src/styles/theme.css",
      ],
      sidebar: [
        { label: "Get started", items: [{ autogenerate: { directory: "get-started" } }] },
        { label: "Concepts", items: [{ autogenerate: { directory: "concepts" } }] },
        {
          label: "Reference",
          collapsed: true,
          items: [{ autogenerate: { directory: "reference" } }],
        },
        { label: "Examples", items: [{ autogenerate: { directory: "examples" } }] },
        { label: "Clients", items: [{ autogenerate: { directory: "clients" } }] },
        { label: "Packages", items: [{ autogenerate: { directory: "packages" } }] },
      ],
      /* `/#the-api`, `/#start`: the home page's sections are components, whose heading ids the
         validator does not see (src/components/home/). */
      plugins: [
        starlightLinksValidator({
          exclude: ({ link }) => PLACEHOLDERS.has(link) || link.startsWith("/#"),
        }),
      ],
      routeMiddleware: "./src/routeData.ts",
      lastUpdated: false,
    }),
  ],
});
