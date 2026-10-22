import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildDraftBody, browserTask } from '../similar-draft.mjs';
import { buildImageDraftBody } from '../image-draft.mjs';

function model() {
  const formValues={productTitle:'Synthetic test',sku:[],extraData:'{}',scImages:{list:[]},icbuCatProp:{'p-3':[{text:'D-SYNTHETIC'}]}};
  const components=Object.fromEntries(Object.keys(formValues).map(key=>[key,{props:{visible:true}}]));
  components.draftBtn={props:{action:'submitDraft.json?pubType=similarPost&from=common&notRefresh=false'}};
  return {models:{global:{id:401,adminAliId:101,pubType:'similarPost',currentPage:0,catId:501},formValues},components};
}
test('serialized body uses supplied frozen scope without module globals',()=>{
  const value=model(),scope={sourceId:401,sellerId:101};
  const result=vm.runInNewContext(`(${buildDraftBody.toString()})(value,'synthetic-run',scope)`,{value,scope,structuredClone,URL});
  assert.equal(result.fields.itemId,401);assert.equal(result.body.productTitle,'Synthetic test');
});
test('serialized image body uses supplied primary role and blocks other roles',()=>{
  const options={sourceId:401,sellerId:101,shopId:'primary_test',model:'D-SYNTHETIC',variant:'synthetic',images:[{fileId:601,fileFlag:'add',fileDestOrder:1,fileURL:'https://example.invalid/test.png'}]};
  const expression=`(${buildImageDraftBody.toString()})(value,'synthetic-run',options,'primary_test')`;
  const context={value:model(),options,structuredClone,URL};
  assert.equal(vm.runInNewContext(expression,context).body.scImages.list[0].fileId,601);
  context.options={...options,shopId:'secondary_test'};
  assert.throws(()=>vm.runInNewContext(expression,context),/d_model_forbidden/);
});
test('browser task rejects missing frozen scope before reading identity',async()=>{
  let requests=0;
  const result=vm.runInNewContext(`(${browserTask.toString()})({op:'prepare'},()=>{})`,{fetch:()=>requests++});
  await assert.rejects(result,/explicit_scope_required/);
  assert.equal(requests,0);
});
