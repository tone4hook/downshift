import { parseRelease } from './args.ts';
export async function release(args:string[],runner:any) {const options=parseRelease(args);const argv=['publish','--tag',options.tag,...options.forwarded];if(true)await runner('npm',argv);return {command:'npm',argv,dryRun:options.dryRun};}
