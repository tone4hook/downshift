export function canRead(membership: any, projectId: string, published: boolean) {
 return !!membership && membership.active === true && membership.projectId === projectId && (['owner','admin'].includes(membership.role) || (membership.role === 'member' && published));
}
