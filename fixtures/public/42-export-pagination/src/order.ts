export function compareRecords(a:any,b:any){return a.updatedAt-b.updatedAt||(a.id<b.id?-1:a.id>b.id?1:0);}
export function afterCursor(row:any,cursor:any){return !cursor||compareRecords(row,cursor)>=0;}
