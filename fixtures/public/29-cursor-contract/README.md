# Cursor Contract

Fix the cursor pagination client. Preserve opaque nextCursor strings exactly, including "0" and spaces; null or undefined means completion. Accumulate items in page order and reject any repeated non-null cursor with CURSOR_LOOP before fetching it again. The initial request uses null. An empty page with a next cursor is not completion.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
