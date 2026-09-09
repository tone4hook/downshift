import { createCache } from './cache.ts';
export function createUserService(repo: any) {
 const cache=createCache();
 return {
  async get(t:string,id:string) { if(cache.has(t,id)) return cache.get(t,id); const value=await repo.get(t,id);cache.set(t,id,value);return value; },
  async update(t:string,id:string,value:any) { cache.remove(t,id);const saved=await repo.update(t,id,value);return saved; }
 };
}
