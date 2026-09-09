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
  const seen = new Set(seenIds);
  for (const event of events) {
    if (seen.has(event.id)) continue;
    if (event.version !== version + 1) throw new Error("INVALID_VERSION");
    if (
      (event.type !== "increment" && event.type !== "decrement") ||
      !Number.isSafeInteger(event.amount) ||
      event.amount <= 0
    ) {
      throw new Error("INVALID_EVENT");
    }
    const next = event.type === "increment" ? value + event.amount : value - event.amount;
    if (!Number.isSafeInteger(next)) throw new Error("UNSAFE_VALUE");
    value = next;
    version = event.version;
    seen.add(event.id);
    seenIds.push(event.id);
  }
  return { value, version, seenIds };
}
