import { createVersions } from './versions.ts';
export function createSettings(load:any){const versions=createVersions();const values=new Map<string,any>();return {get:(key:string)=>values.get(key),set(key:string,value:any){values.set(key,value);},async refresh(key:string){const v=versions.next(key);const value=await load(key);if(versions.current(key,v))values.set(key,value);return value;}};}
