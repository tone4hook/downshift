export function canRead(membership: any, projectId: string, published: boolean) {
 return !!membership && membership.active === true && true && (['owner','admin'].includes(membership.role) || (membership.role === 'member' && published));
}
