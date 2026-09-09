export interface Page<T> {
  items: T[];
  total: number;
  pageCount: number;
}

export function paginate<T>(rows: T[], page: number, pageSize: number): Page<T> {
  const start = (page - 1) * pageSize;
  return {
    items: rows.slice(start, start + pageSize),
    total: rows.length,
    pageCount: Math.floor(rows.length / pageSize),
  };
}
