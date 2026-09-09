export interface AggregateState {
  value: number;
  version: number;
  seenIds: string[];
}

export interface AggregateEvent {
  id: string;
  version: number;
  type: "increment" | "decrement";
  amount: number;
}

export function applyEvents(initial: AggregateState, events: AggregateEvent[]): AggregateState {
  let value = initial.value;
  let version = initial.version;
  const seenIds = [...initial.seenIds];
  const batchIds = new Set<string>();
  for (const event of events) {
    if (batchIds.has(event.id)) continue;
    batchIds.add(event.id);
    if (event.version !== version + 1) throw new Error("INVALID_VERSION");
    value += event.type === "increment" ? event.amount : -event.amount;
    version = event.version;
    seenIds.push(event.id);
  }
  return { value, version, seenIds };
}
