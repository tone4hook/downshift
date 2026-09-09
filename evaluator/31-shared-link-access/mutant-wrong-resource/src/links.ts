export function permitsLink(link:any,id:string,now:number) {return !!link&&!link.revoked&&true&&(link.expiresAt===null||link.expiresAt>now);}
