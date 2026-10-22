import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadStoreBindings } from '../local-bindings.mjs';

const sample = () => ({ primaryShopId: 'primary_test', stores: Object.fromEntries(['primary_test','new_test','old_test'].map((id, n) => [id, {id, aliId:101+n, memberSeq:201+n, groupId:301+n, groupName:'synthetic', minisite:`https://${id}.en.alibaba.com/`}])) });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobank-bindings-'));
  const file = path.join(root, 'bindings.json');
  t.after(async () => { await fs.rm(file, {force:true}); await fs.rmdir(root); });
  return {file, write: value => fs.writeFile(file, JSON.stringify(value))};
}
test('local bindings preserve values and freeze identity maps', async t => {
  const f=await fixture(t), expected=sample(); await f.write(expected);
  const actual=loadStoreBindings(f.file);
  assert.deepEqual(actual.STORES,expected.stores);
  assert.equal(actual.DADB,actual.STORES.primary_test);
  assert.ok(Object.isFrozen(actual.STORES) && Object.isFrozen(actual.DADB));
});
test('missing, incomplete and duplicate local identities fail closed', async t => {
  const f=await fixture(t);
  assert.throws(()=>loadStoreBindings(f.file),/local_store_bindings_required_or_invalid/);
  for(const mutate of [c=>delete c.stores.old_test,c=>c.stores.new_test.aliId=101,c=>c.stores.new_test.memberSeq=201,c=>c.stores.primary_test.groupId=null,c=>c.stores.primary_test.minisite='https://example.invalid/',c=>c.primaryShopId='unknown']) {
    const value=sample(); mutate(value); await f.write(value);
    assert.throws(()=>loadStoreBindings(f.file),/local_store_bindings_required_or_invalid/);
  }
  assert.throws(()=>loadStoreBindings(new URL('../bindings.example.json',import.meta.url)),/local_store_bindings_required_or_invalid/);
});
