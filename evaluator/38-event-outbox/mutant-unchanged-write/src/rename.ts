import { renameEvent, normalizeName } from './event.ts';
export async function renameUser(repo:any,id:string,name:string){const normalized=normalizeName(name);return repo.transaction(async(tx:any)=>{const user=await tx.user(id);if(!user)throw Error('NOT_FOUND');const updated={...user,name:normalized};await tx.update(updated);await tx.append(renameEvent(user,normalized));return updated;});}
