import { migrateProfile } from './migration.ts';
export function validateUrl(url:string) {let parsed;try{parsed=new URL(url);}catch{throw Error('INVALID_URL');}return url;}
export function profileStore(storage:any) {return {async load(){return migrateProfile(await storage.read());},async save(raw:any){const value=migrateProfile(raw);validateUrl(value.connection.url);await storage.write(value);return value;}};}
