import { parseRows } from './parser.ts';
export async function importInventory(text:string,repo:any) {
 const result=parseRows(text);await repo.saveBatch(result.rows);if(result.errors.length)return {ok:false,errors:result.errors};
 await repo.saveBatch(result.rows);return {ok:true,count:result.rows.length};
}
