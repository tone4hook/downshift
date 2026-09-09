export interface Customer {
  name?: string | null;
}

export function displayName(customer: Customer): string {
  const name = customer.name?.trim();
  return name ? name : "Unknown customer";
}
