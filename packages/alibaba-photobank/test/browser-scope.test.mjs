import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { browserTask } from '../browser.mjs';

const store={id:'primary_test',aliId:101,memberSeq:201,groupId:301,groupName:'synthetic',minisite:'https://primary_test.en.alibaba.com/'};
async function execute(allowDModels, wrongSeller=false) {
  let requests=0;
  const p={op:'preflight',asset:{model:'D-SYNTHETIC'},store:{...store,allowDModels}};
  const context={window:{},location:{origin:'https://photobank.alibaba.com'},fetch:async raw=>{
    requests++;
    const data=raw.includes('sellerProfileAjax')?{adminAliId:wrongSeller?999:store.aliId,adminMbrSeq:store.memberSeq,minisite:store.minisite}:{success:true,data:[{id:store.groupId,name:store.groupName,aliMemberId:store.memberSeq}]};
    return {ok:true,json:async()=>data};
  }};
  const result=vm.runInNewContext(`(${browserTask.toString()})(${JSON.stringify(p)})`,context);
  return {result,requests:()=>requests};
}
test('serialized primary role permits D models and checks identity before and after',async()=>{
  const run=await execute(true);await run.result;assert.equal(run.requests(),3);
});
test('missing or secondary role blocks D models before any request',async()=>{
  for(const allow of [undefined,false]) {const run=await execute(allow);await assert.rejects(run.result,/d_model_forbidden/);assert.equal(run.requests(),0);}
});
test('primary role never bypasses live seller identity validation',async()=>{
  const run=await execute(true,true);await assert.rejects(run.result,/seller_identity_mismatch/);assert.equal(run.requests(),1);
});
