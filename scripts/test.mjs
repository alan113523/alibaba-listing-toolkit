import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const project=fileURLToPath(new URL('../',import.meta.url));
const files=(await fs.readFile(path.join(project,'SAFE_FILES.txt'),'utf8')).trim().split(/\r?\n/);
const sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'alibaba-listing-offline-'));
assert(path.resolve(sandbox).startsWith(path.join(path.resolve(os.tmpdir()),'alibaba-listing-offline-')));
try {
  for(const relative of files.filter(file=>file.startsWith('packages/'))){
    const target=path.join(sandbox,relative);await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.copyFile(path.join(project,relative),target);
  }
  const ids=['primary_test','secondary_a','secondary_b'];
  const photo={primaryShopId:ids[0],stores:Object.fromEntries(ids.map((id,n)=>[id,{id,aliId:101+n,memberSeq:201+n,groupId:301+n,groupName:'synthetic',minisite:`https://${id}.en.alibaba.com/`}]))};
  const draft={primaryShopId:ids[0],sourceId:401,sellerId:101,stores:Object.fromEntries(ids.map((id,n)=>[id,{sellerId:101+n,minisite:`https://${id}.en.alibaba.com/`}]))};
  for(const [name,config]of [['alibaba-draft-interface',draft],['alibaba-photobank',photo]]){
    const dir=path.join(sandbox,'packages',name,'.local');await fs.mkdir(dir,{recursive:true});
    await fs.writeFile(path.join(dir,'store-bindings.json'),JSON.stringify(config));
  }
  const tests=files.filter(file=>file.endsWith('.test.mjs')).map(file=>path.join(sandbox,file));
  const result=spawnSync(process.execPath,['--test',...tests],{cwd:sandbox,stdio:'inherit'});
  if(result.error)throw result.error;
  process.exitCode=result.status??1;
} finally {
  assert(path.resolve(sandbox).startsWith(path.join(path.resolve(os.tmpdir()),'alibaba-listing-offline-')));
  await fs.rm(sandbox,{recursive:true,force:true});
}
