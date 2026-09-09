export interface Item {
  id: string;
  title: string;
  status: "active" | "archived";
  quantity: number;
}

export interface ItemQuery {
  text?: string;
  status?: Item["status"];
}

export function filterItems(items: Item[], query: ItemQuery): Item[] {
  const text = query.text?.trim().toLowerCase();
  return items.filter(
    (item) =>
      (text !== undefined && item.title.toLowerCase().includes(text)) ||
      (query.status !== undefined && item.status === query.status),
  );
}
