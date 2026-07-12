import { defineConfig } from "wxt";
import react from "@vitejs/plugin-react";

export default defineConfig({
  vite: () => ({ plugins: [react()] }),
  manifest: {
    name: "IMDb Shows Tracker",
    description: "A private, local TV episode tracker for IMDb lists.",
    version: "0.1.0",
    permissions: ["storage", "alarms"],
    host_permissions: ["https://www.imdb.com/*", "https://api.tvmaze.com/*"],
    action: { default_title: "Open IMDb Shows Tracker" },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  },
});
