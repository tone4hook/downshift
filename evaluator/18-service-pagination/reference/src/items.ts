export interface Item {
  id: string;
  title: string;
  status: "active" | "archived";
  quantity: number;
}

export interface StoredItem extends Item {
  tenantId: string;
}

export interface ListRequest {
  page?: string;
  pageSize?: string;
  text?: string;
  status?: string;
}

export interface ItemRepository {
  list(): readonly StoredItem[];
}

function positiveDecimal(value: string, maximum?: number): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error("INVALID_QUERY");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (maximum !== undefined && parsed > maximum)) {
    throw new Error("INVALID_QUERY");
  }
  return parsed;
}

export function createItemService(repo: ItemRepository): {
  listItems(
    request: ListRequest,
    user: { tenantId: string },
  ): { items: Item[]; total: number; page: number; pageSize: number };
} {
  return {
    listItems(request, user) {
      const page = positiveDecimal(request.page ?? "1");
      const pageSize = positiveDecimal(request.pageSize ?? "20", 100);
      if (
        request.status !== undefined &&
        request.status !== "active" &&
        request.status !== "archived"
      ) {
        throw new Error("INVALID_QUERY");
      }
      const text = request.text?.trim().toLowerCase() ?? "";
      const filtered = repo.list()
        .filter((item) =>
          item.tenantId === user.tenantId &&
          (request.status === undefined || item.status === request.status) &&
          (text === "" || item.title.toLowerCase().includes(text)))
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      const start = (page - 1) * pageSize;
      return {
        items: filtered.slice(start, start + pageSize).map(
          ({ tenantId: _tenantId, ...item }) => item,
        ),
        total: filtered.length,
        page,
        pageSize,
      };
    },
  };
}
