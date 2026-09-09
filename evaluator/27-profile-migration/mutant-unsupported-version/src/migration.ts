export function migrateProfile(raw:any) {
 if(raw.version===1)return {version:2,name:raw.name,connection:{url:raw.endpoint},enabled:true};

 return {version:2,name:raw.name,connection:{url:raw.connection.url},enabled:raw.enabled??true};
}
