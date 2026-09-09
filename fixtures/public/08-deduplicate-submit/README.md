# Deduplicate submissions

Implement `createSubmitter(save)` in `src/submitter.ts`.

- Concurrent submissions with the same key share the exact pending promise and one save.
- The first value supplied while a key is pending wins.
- Different keys remain independent.
- Success or rejection releases the key, so a later call starts new work.
