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

export function createItemService(repo: ItemRepository) {
  return {
    listItems(request: ListRequest, user: { tenantId: string }) {
      const page = Number(request.page ?? "1");
      const pageSize = Number(request.pageSize ?? "20");
      const start = (page - 1) * pageSize;
      const text = request.text?.trim().toLowerCase() ?? "";
      const rows = repo.list().slice(start, start + pageSize).filter((item) =>
        item.tenantId === user.tenantId &&
        (request.status === undefined || item.status === request.status) &&
        (text === "" || item.title.toLowerCase().includes(text)));
      return {
        items: rows.map(({ tenantId: _tenantId, ...item }) => item),
        total: rows.length,
        page,
        pageSize,
      };
    },
  };
}
