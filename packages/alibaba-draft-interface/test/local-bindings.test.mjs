import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadDraftBindings } from '../local-bindings.mjs';

const sample = () => ({ primaryShopId:'primary_test', sourceId:401, sellerId:101, stores:Object.fromEntries(['primary_test','new_test','old_test'].map((id,n)=>[id,{sellerId:101+n,minisite:`https://${id}.en.alibaba.com/`}])) });
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'draft-bindings-'));
  const file=path.join(root,'bindings.json');
  t.after(async()=>{await fs.rm(file,{force:true});await fs.rmdir(root);});
  return {file,write:value=>fs.writeFile(file,JSON.stringify(value))};
}
test('legacy scope values and store maps load unchanged',async t=>{
  const f=await fixture(t),expected=sample();await f.write(expected);
  const actual=loadDraftBindings(f.file);
  assert.equal(actual.SOURCE_ID,expected.sourceId);assert.equal(actual.SELLER_ID,expected.sellerId);
  assert.equal(actual.PRIMARY_SHOP_ID,expected.primaryShopId);assert.deepEqual(actual.STORE_BINDINGS,expected.stores);
  assert.ok(Object.isFrozen(actual.STORE_BINDINGS) && Object.isFrozen(actual.STORE_BINDINGS.primary_test));
});
test('missing, mismatched and incomplete legacy bindings fail closed',async t=>{
  const f=await fixture(t);
  assert.throws(()=>loadDraftBindings(f.file),/local_draft_bindings_required_or_invalid/);
  for(const mutate of [c=>delete c.stores.old_test,c=>c.sourceId=null,c=>c.sellerId=999,c=>c.stores.new_test.sellerId=101,c=>c.stores.primary_test.minisite='https://example.invalid/',c=>c.primaryShopId='unknown']) {
    const value=sample();mutate(value);await f.write(value);
    assert.throws(()=>loadDraftBindings(f.file),/local_draft_bindings_required_or_invalid/);
  }
  assert.throws(()=>loadDraftBindings(new URL('../bindings.example.json',import.meta.url)),/local_draft_bindings_required_or_invalid/);
});
