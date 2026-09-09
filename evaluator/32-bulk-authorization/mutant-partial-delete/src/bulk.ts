import { authorizeDelete } from './authorize.ts';
export async function deleteMany(repo:any,user:any,ids:string[]){const unique=[...new Set(ids)];if(!unique.length)return 0;for(const id of unique){const row=await repo.get(id);if(!row)throw Error('NOT_FOUND');authorizeDelete(user,row);await repo.remove([id]);}await repo.remove(unique);return unique.length;}
