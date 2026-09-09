export interface Customer {
  name?: string | null;
}

export function displayName(customer: Customer): string {
  return customer.name?.trim() ?? "Unknown customer";
}
