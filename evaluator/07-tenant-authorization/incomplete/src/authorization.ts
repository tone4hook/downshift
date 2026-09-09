export interface User {
  id: string;
  role: "admin" | "member";
  tenantId: string;
}

export interface RecordIdentity {
  ownerId: string;
  tenantId: string;
}

export function canEdit(user: User, record: RecordIdentity): boolean {
  return user.role === "admin" ||
    (user.tenantId === record.tenantId && user.id === record.ownerId);
}
