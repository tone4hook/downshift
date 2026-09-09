export function authorizeDelete(user:any,row:any){if(user.tenantId!==row.tenantId||(user.role!=='admin'&&user.id!==row.ownerId))throw Error('FORBIDDEN');}
