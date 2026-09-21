## Verification scope

Match verification effort to the size of the change. Don't launch a full browser/Playwright
session for every edit — it's slow and often unnecessary.

**Always run** (fast, cheap, do it every time code changes):
- `npm run typecheck`
- `npm run lint`
- `npm run test`

**That's usually enough for:**
- Copy/text changes, a threshold tweak, hiding/showing something behind an existing condition,
  a single CSS property change, adding a field that already has test coverage on the code path
  that uses it.
- If you want a visual sanity check for one of these, a single screenshot of the changed area
  is enough — no need for a multi-page sweep or a scripted interaction flow.

**Worth an actual browser check** (real user interaction, not just reading the code):
- New components, especially anything with a modal/overlay/portal, custom positioning, or
  z-index.
- Anything involving scroll behavior, focus management, or CSS containing-block edge cases
  (`transform`/`filter`/`will-change` on an ancestor changes how `position: fixed` behaves).
- New interactive flows (wizards, multi-step forms, drag/drop, search-as-you-type).
- Layout changes using flexbox/grid where `max-width`, `flex: 1`, and `justify-content` combine
  non-obviously.

This project has already hit real runtime-only bugs that looked correct in code: a CSS
specificity collision misaligning a spinner, `overflow: hidden` silently zeroing a scroll
position instead of just hiding the scrollbar, and a `.route-stage` entrance animation's
`transform` turning it into the containing block for a `position: fixed` modal (so the modal
centered against the whole page instead of the viewport). None of these were visible from
reading the CSS/JSX alone. That's the category worth spinning up a browser for.

When unsure which category a change falls into, default to typecheck/lint/test only and say so,
rather than defaulting to a full browser session.
