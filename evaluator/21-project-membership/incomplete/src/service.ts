import { canRead } from './policy.ts';
export async function readDocument(repo: any, membership: any, projectId: string, documentId: string, published: boolean) {
 if (!canRead(membership, projectId, published)) throw new Error('FORBIDDEN');
 const row = await repo.get(projectId, documentId);
 if (!row) throw new Error('NOT_FOUND');
 const {secret, ...safe} = row;
 return safe;
}
