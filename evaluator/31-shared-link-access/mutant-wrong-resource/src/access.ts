import { permitsLink } from './links.ts';
export async function openShared(repo:any,key:string,id:string,clock:()=>number){const link=await repo.link(key);if(!permitsLink(link,id,clock()))throw Error('FORBIDDEN');const resource=await repo.resource(id);if(!resource)throw Error('NOT_FOUND');const {internalToken,...publicValue}=resource;return publicValue;}
