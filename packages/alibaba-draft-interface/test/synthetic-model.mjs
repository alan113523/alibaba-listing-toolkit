export function syntheticModel() {
  const formValues = {
    productTitle:'Synthetic diffuser for adapter tests',
    textDesc:'Generated test content',
    productDescType:{value:4},
    scPrice:{value:1},
    ladderPrice:[{quantity:1,price:'10'}],
    sku:Array.from({length:8},(_,n)=>({skuId:0,allProps:[],index:n,props:[{id:1,value:n}],price:'10',inventory:1})),
    sampleSku:[{props:[{id:1,value:0}],price:'12',moq:1}],
    saleAttributesItems:[{value:0,text:'synthetic'}],
    icbuCatProp:{'p-3':[{text:'SYNTHETIC'}]},
    scImages:{list:[]},
    imageMedia:{videoId:''},
    productKeywords:['synthetic'],
    detailImage:[],companyImage:[],companyDesc:'Synthetic company',companyFaqDesc:[],
    newCustomizedServices:JSON.stringify({customContent:[{customType:'logo',moq:1}]}),
    extraData:'{}',superText:'unused synthetic text'
  };
  const components=Object.fromEntries(Object.keys(formValues).map(key=>[key,{props:{visible:key!=='superText'}}]));
  components.draftBtn={props:{action:'submitDraft.json?pubType=similarPost&from=common&notRefresh=false'}};
  return {models:{global:{id:401,adminAliId:101,catId:501,pubType:'similarPost',currentPage:0,cache:{},value:{},globalSwitcher:{enableDetailStruct:true,enableAiDetail:true}},formValues},components};
}
