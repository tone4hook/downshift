export interface ImportRow {
  id?: unknown;
  title?: unknown;
}

export interface ImportResult {
  accepted: Array<{ id: string; title: string }>;
  errors: Array<{ row: number; fields: string[] }>;
}

export function importRows(rows: ImportRow[], existingIds: Set<string>): ImportResult {
  const accepted: ImportResult["accepted"] = [];
  for (let row = 0; row < rows.length; row++) {
    const id = typeof rows[row].id === "string" ? rows[row].id.trim() : "";
    const title = typeof rows[row].title === "string" ? rows[row].title.trim() : "";
    if (!id || !title || title.length > 80 || existingIds.has(id)) {
      return { accepted, errors: [{ row, fields: ["id", "title"] }] };
    }
    accepted.push({ id, title });
    existingIds.add(id);
  }
  return { accepted, errors: [] };
}
