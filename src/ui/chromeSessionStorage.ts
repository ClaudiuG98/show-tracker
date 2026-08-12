import type { StateStorage } from "zustand/middleware";

// Backs zustand's `persist` middleware with chrome.storage.session (ephemeral, cleared on
// browser restart) so wizard-style UI state survives navigating away and back within the
// dashboard, and an accidentally closed tab, without lingering forever like chrome.storage.local.
export const chromeSessionStorage: StateStorage = {
  async getItem(name) {
    if (typeof chrome === "undefined" || !chrome.storage?.session) return null;
    const result = await chrome.storage.session.get(name) as Record<string, string | undefined>;
    return result[name] ?? null;
  },
  async setItem(name, value) {
    if (typeof chrome === "undefined" || !chrome.storage?.session) return;
    try {
      await chrome.storage.session.set({ [name]: value });
    } catch {
      // chrome.storage.session has a fixed ~10MB quota (no unlimitedStorage permission is
      // requested). A large import's analysis can exceed that; when it does, degrade to
      // "doesn't survive a closed tab" for this write rather than an unhandled rejection --
      // the in-memory store still works fine for the rest of the current tab session.
    }
  },
  async removeItem(name) {
    if (typeof chrome === "undefined" || !chrome.storage?.session) return;
    await chrome.storage.session.remove(name);
  },
};
