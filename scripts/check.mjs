import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const files=(await fs.readFile(path.join(root,'SAFE_FILES.txt'),'utf8')).trim().split(/\r?\n/);
assert.equal(new Set(files).size,files.length,'Duplicate public file');
let syntax=0,links=0;
for(const relative of files){
  assert(!path.isAbsolute(relative)&&!relative.includes('..'),'Nonlocal allowlist entry');
  assert(!/(?:^|\/)(?:\.local|state|validation|runs|outputs|node_modules)(?:\/|$)/.test(relative),'Private path in allowlist');
  const target=path.join(root,relative),content=await fs.readFile(target,'utf8');
  assert(!/\b[A-Z]:[/\\]/i.test(content),'Machine path in '+relative);
  if(relative.endsWith('.mjs')){execFileSync(process.execPath,['--check',target]);syntax++;}
  if(relative.endsWith('.json'))JSON.parse(content);
  if(relative.endsWith('.md'))for(const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){
    const href=match[1].replace(/^<|>$/g,'');if(/^https?:/.test(href)||href.startsWith('#'))continue;
    await fs.access(path.resolve(path.dirname(target),href.replace(/#.*$/,'')));links++;
  }
}
console.log(JSON.stringify({ok:true,publicFiles:files.length,syntaxChecks:syntax,localLinks:links,platformRequests:0},null,2));
