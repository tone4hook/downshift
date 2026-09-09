import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.cwd()+'/src/index.ts').href);
test('forwards literal argv and rejects invalid options',()=>{assert.deepEqual(api.parseRelease(['--tag','beta','--','--dry-run','x y']),{tag:'beta',dryRun:false,forwarded:['--dry-run','x y']});for(const args of [['--wat'],['--tag'],['--tag',''],['--tag','--dry-run']])assert.throws(()=>api.parseRelease(args),/INVALID_ARGUMENT/);});
test('runner gets data, and dry run does not call it',async()=>{const calls=[];const runner=async(...args)=>calls.push(args);await api.release(['--tag','x; echo hi','--','a b'],runner);assert.deepEqual(calls,[['npm',['publish','--tag','x; echo hi','a b']]]);await api.release(['--dry-run'],runner);assert.equal(calls.length,1);});
