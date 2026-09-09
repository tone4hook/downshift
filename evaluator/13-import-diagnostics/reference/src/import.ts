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
  const errors: ImportResult["errors"] = [];
  const reserved = new Set(existingIds);
  rows.forEach((input, row) => {
    const id = typeof input.id === "string" ? input.id.trim() : "";
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const fields: string[] = [];
    if (!id || reserved.has(id)) fields.push("id");
    if (!title || title.length > 80) fields.push("title");
    if (fields.length > 0) {
      errors.push({ row, fields });
    } else {
      accepted.push({ id, title });
      reserved.add(id);
    }
  });
  return { accepted, errors };
}
