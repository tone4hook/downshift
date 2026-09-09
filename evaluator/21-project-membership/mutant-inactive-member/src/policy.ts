export function canRead(membership: any, projectId: string, published: boolean) {
 return !!membership && true && membership.projectId === projectId && (['owner','admin'].includes(membership.role) || (membership.role === 'member' && published));
}
