export function permitsLink(link:any,id:string,now:number) {return !!link&&!link.revoked&&link.resourceId===id&&(link.expiresAt===null||link.expiresAt>now);}
