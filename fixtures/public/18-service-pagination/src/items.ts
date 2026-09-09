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

export function createItemService(repo: ItemRepository): {
  listItems(
    request: ListRequest,
    user: { tenantId: string },
  ): { items: Item[]; total: number; page: number; pageSize: number };
} {
  return {
    listItems(request, user) {
      const page = Number(request.page ?? "1");
      const pageSize = Number(request.pageSize ?? "20");
      const start = (page - 1) * pageSize;
      const pageRows = repo.list().slice(start, start + pageSize);
      const filtered = pageRows.filter((item) => item.tenantId === user.tenantId);
      return {
        items: filtered.map(({ tenantId: _tenantId, ...item }) => item),
        total: filtered.length,
        page,
        pageSize,
      };
    },
  };
}
