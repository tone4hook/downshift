export function renameEvent(user:any,name:string){return {type:'user.renamed',payload:{...user,userId:user.id,name}};}
export function normalizeName(name:string){const normalized=name.trim();if(normalized.length<1||normalized.length>80)throw Error('INVALID_NAME');return normalized;}
