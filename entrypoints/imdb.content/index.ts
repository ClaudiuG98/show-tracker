import { GLOBAL_HOST_ID, TITLE_HOST_ID, synchronizeImdbControls } from "../../src/imdb/integration";

export default defineContentScript({ matches: ["https://www.imdb.com/*"], runAt: "document_start", main() {
  let previous = location.pathname, queued = false;
  const sync = () => {
    if (!document.body || queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; void synchronizeImdbControls(document, location.pathname, (message) => chrome.runtime.sendMessage(message)); });
  };
  const begin = () => {
    sync();
    new MutationObserver(() => {
      if (previous !== location.pathname) { previous = location.pathname; document.getElementById(TITLE_HOST_ID)?.remove(); }
      if (!document.getElementById(GLOBAL_HOST_ID) || location.pathname.startsWith("/title/")) sync();
    }).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.body) begin(); else document.addEventListener("DOMContentLoaded", begin, { once: true });
} });
