import { createExpiringCache } from './expiry.ts';
export function createDirectory(load:any,ttl:number,clock:()=>number){const cache=createExpiringCache(ttl,clock);return {async find(key:string){const entry=cache.read(key);if(entry.hit)return entry.value;const value=await load(key);cache.write(key,value);return value;}};}
