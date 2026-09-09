export function parseRelease(args:string[]) {
 let tag='latest',dryRun=false;const forwarded:string[]=[];
 for(let i=0;i<args.length;i++){const arg=args[i];if(arg==='--'){forwarded.push(...args.slice(i+2));break;}if(arg==='--dry-run'){dryRun=true;continue;}if(arg==='--tag'){const value=args[++i];if(!value||value.startsWith('--'))throw Error('INVALID_ARGUMENT');tag=value;continue;}throw Error('INVALID_ARGUMENT');}
 return {tag,dryRun,forwarded};
}
