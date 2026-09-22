import { defineConfig } from "wxt";
import react from "@vitejs/plugin-react";

export default defineConfig({
  manifestVersion: 3,
  vite: () => ({ plugins: [react()] }),
  zip: {
    excludeSources: ["initial-data/**", "test-results/**", "playwright-report/**", "coverage/**", "**/*.pem", "**/*.key", "**/*.zip", "**/*.xpi"],
  },
  manifest: ({ browser }) => ({
    ...(browser === "firefox" ? { browser_specific_settings: { gecko: {
      id: "show-tracker@claudiug98.github.io",
      strict_min_version: "140.0",
      data_collection_permissions: { required: ["searchTerms", "websiteContent"] },
    } } } : {}),
    name: "Show Tracker",
    short_name: "Show Tracker",
    description: "A private, local TV episode tracker with flexible imports.",
    version: "0.1.0",
    permissions: ["storage", "alarms"],
    optional_permissions: ["downloads"],
    host_permissions: ["https://www.imdb.com/*", "https://api.tvmaze.com/*"],
    icons: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    },
    web_accessible_resources: [{
      resources: ["icons/icon-32.png", "icons/imdb-mark-32.png"],
      matches: ["https://www.imdb.com/*"],
    }],
    action: {
      default_title: "Open Show Tracker",
      default_icon: {
        16: "icons/icon-16.png",
        32: "icons/icon-32.png",
        48: "icons/icon-48.png",
        128: "icons/icon-128.png",
      },
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  }),
});
