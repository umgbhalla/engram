import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

const LIVE_DEMO = "https://engram-ui.umg-bhalla88.workers.dev";
const REPO = "https://github.com/umgbhalla/montydyn";

export default defineConfig({
  // Static output served by Cloudflare Workers Assets.
  outDir: "./dist",
  trailingSlash: "ignore",
  integrations: [
    starlight({
      title: "Engram",
      description:
        "A durable, hibernating, multi-tenant JavaScript / TypeScript REPL kernel on Cloudflare — the live interpreter heap is snapshotted to durable storage, so a session sleeps when idle and wakes with full live state, no replay.",
      tagline: "Durable hibernating REPL kernel on the edge",
      customCss: ["./src/styles/engram.css"],
      logo: { src: "./src/assets/mark.svg", replacesTitle: false },
      social: [
        { icon: "github", label: "GitHub", href: REPO },
        { icon: "rocket", label: "Live demo", href: LIVE_DEMO },
      ],
      components: {
        SocialIcons: "./src/components/TopLinks.astro",
      },
      sidebar: [
        {
          label: "Overview",
          items: [
            { label: "What is Engram", slug: "overview/what-is-engram" },
            { label: "The core bet", slug: "overview/core-bet" },
            { label: "What works today", slug: "overview/what-works" },
          ],
        },
        {
          label: "How it works",
          items: [
            { label: "Architecture", slug: "how-it-works/architecture" },
            { label: "Snapshot / restore", slug: "how-it-works/snapshot-restore" },
            { label: "Diagrams", slug: "how-it-works/diagrams" },
          ],
        },
        {
          label: "Durability",
          items: [
            { label: "Hibernation & determinism", slug: "durability/hibernation" },
            { label: "Guards", slug: "durability/guards" },
            { label: "Operating envelope", slug: "durability/envelope" },
          ],
        },
        {
          label: "Using it",
          items: [
            { label: "Quick start", slug: "using/quick-start" },
            { label: "SDK", slug: "using/sdk" },
            { label: "CLI REPL", slug: "using/cli" },
            { label: "Notebook UI", slug: "using/ui" },
            { label: "TypeScript cells", slug: "using/typescript" },
          ],
        },
        {
          label: "Architecture & ADRs",
          items: [
            { label: "Decision records", slug: "architecture/adrs" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Frame protocol & config", slug: "reference/protocol" },
            { label: "Deployed surface", slug: "reference/deployed" },
          ],
        },
      ],
    }),
  ],
});
