# Export Pagination

Fix export pagination over an immutable snapshot. Filter by tenant and minimum updatedAt before sorting by numeric updatedAt and then code-point ID. Paginate by the exclusive (updatedAt,id) cursor, with a positive integer limit <=100. Return only id/value/updatedAt and the last returned tuple as nextCursor only when more matching records remain. Preserve input order and contents. Missing cursor means the first page.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
