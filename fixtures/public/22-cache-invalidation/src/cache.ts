export function cacheKey(tenant: string, id: string) { return id; }
export function createCache() {
 const rows = new Map<string,any>();
 return {has:(t:string,id:string)=>rows.has(cacheKey(t,id)), get:(t:string,id:string)=>rows.get(cacheKey(t,id)), set:(t:string,id:string,v:any)=>rows.set(cacheKey(t,id),v), remove:(t:string,id:string)=>rows.delete(cacheKey(t,id))};
}
