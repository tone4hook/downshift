# Archive Import

Repair archive entry validation and import planning. Accept only relative forward-slash paths without empty, dot, dot-dot, drive, or backslash components; reject links and duplicate paths with INVALID_ARCHIVE. Enforce the total byte budget across all entries, using UTF-8 byte lengths, before any write. Validate the entire archive first; successful import writes entries in input order and returns the count. Preserve source entries.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
