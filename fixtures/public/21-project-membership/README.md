# Project Membership

Fix project document reads: only active memberships in the requested project may grant access. Owners and admins can read any document there; members can read published documents only. Enforce authorization before reading document storage, return NOT_FOUND for missing documents after access succeeds, and omit secret from the returned document. Keep source records unchanged.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
