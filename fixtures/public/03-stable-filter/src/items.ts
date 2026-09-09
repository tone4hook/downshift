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

export function filterItems(items: Item[], _query: ItemQuery): Item[] {
  return items;
}
