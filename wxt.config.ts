import { defineConfig } from "wxt";
import react from "@vitejs/plugin-react";

export default defineConfig({
  vite: () => ({ plugins: [react()] }),
  manifest: {
    name: "TV Show Tracker for IMDb – TV Time Import",
    short_name: "TV Show Tracker",
    description: "A private, local TV episode tracker for IMDb lists.",
    version: "0.1.0",
    permissions: ["storage", "alarms"],
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
      default_title: "Open TV Show Tracker",
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
  },
});
