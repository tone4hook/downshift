# Latest search

Fix `createSearchController(fetchResults, publish).search(query)` in
`src/search.ts`.

- Only the latest started request may publish.
- The latest success publishes its query, results, and `error: null`.
- The latest failure publishes empty results and the error message.
- Stale successes and failures publish nothing, and every `search` promise resolves after handling.
