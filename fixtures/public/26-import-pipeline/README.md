# Import Pipeline

Repair the CSV-like inventory import pipeline. Parse CRLF or LF lines with exactly two comma-separated fields (SKU, positive integer quantity); trim fields and ignore blank lines. Collect all diagnostics using physical 1-based line numbers, reject duplicate SKUs, and make zero storage writes if any line is invalid. Valid rows are saved once in one batch. Keep parseRows and importInventory APIs.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
