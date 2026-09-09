import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
test('strict TypeScript module integration',()=>{
  assert.ok(process.env.LAB_TYPESCRIPT_BIN);
  const result=spawnSync(process.execPath,[process.env.LAB_TYPESCRIPT_BIN,'--noEmit','--strict','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','--allowImportingTsExtensions','--skipLibCheck',process.cwd()+'/src/index.ts'],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
});
