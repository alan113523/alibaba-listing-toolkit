import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyBatch} from '../verify-batch.mjs';

function fixture(){
  const initial={productTitle:'Synthetic title',sku:[{skuId:0,index:0,allProps:[],props:[{value:1}],price:'10'}],sampleSku:[{skuId:0,index:0,allProps:[],props:[{value:1}],price:'12'}],saleAttributesItems:[{value:1,text:'synthetic'}],scImages:{list:[]},imageMedia:{videoId:''},productKeywords:['synthetic'],superText:'',extraData:JSON.stringify({uniqueId:'syntheticrun'}),newCustomizedServices:JSON.stringify({customContent:[{customType:'logo',moq:1}]})};
  const source=structuredClone(initial),draft=structuredClone(initial);
  draft.scImages.fileType='static';draft.imageMedia.active=true;
  return {
    manifest:{batchId:'synthetic-batch',shop:'primary_test',sellerId:101,sourceId:401,jobs:['synthetic-run'],allowedPostCount:1},
    prepared:[{runId:'synthetic-run',value:{source,initial,seller:{aliId:101},request:{payload:{extraData:initial.extraData}}}}],
    receipts:[{runId:'synthetic-run',value:{newDraftId:701},startedMs:1,endedMs:2}],
    readback:[{runId:'synthetic-run',value:{draft,sourceAfter:structuredClone(source),seller:{aliId:101},draftGlobal:{pubAction:'draft'},newDraftId:701}}]
  };
}
test('synthetic readback accepts only the observed metadata normalization',()=>{
  assert.equal(verifyBatch(fixture()).status,'verified');
});
test('prices, source fields and seller changes fail verification',()=>{
  for(const mutate of [x=>x.readback[0].value.draft.sampleSku[0].price='99',x=>x.readback[0].value.sourceAfter.productTitle='changed',x=>x.readback[0].value.seller.aliId=999]){
    const input=fixture();mutate(input);assert.equal(verifyBatch(input).status,'failed');
  }
});
