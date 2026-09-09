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
  const state = { ...initial, seenIds: [...initial.seenIds] };
  for (const event of events) {
    state.value += event.type === "increment" ? event.amount : -event.amount;
    state.version = event.version;
    state.seenIds.push(event.id);
  }
  return state;
}
