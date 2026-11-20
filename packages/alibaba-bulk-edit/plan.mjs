import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const tools = Object.freeze({
  attributes: 'product_edit_draft_basic_info',
  trade: 'product_edit_draft_trade',
  sample: 'product_edit_draft_sample',
  submit: 'product_submit_draft',
  query: 'product_query_information'
});

export const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOnly = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
const operation = value => ['ADD', 'EDIT'].includes(value);

function price(value) {
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fractional = ''] = value.split('.');
  return `${whole.replace(/^0+(?=\d)/, '')}.${fractional.padEnd(2, '0')}`;
}

export function loadPlan(scopePath) {
  const bytes = readFileSync(scopePath);
  const scope = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (!hasOnly(scope, ['stores', 'products']) || !object(scope.stores) ||
      !Array.isArray(scope.products) || !scope.products.length) throw Error('INVALID_SCOPE');

  const sellers = new Set();
  for (const [store, sellerId] of Object.entries(scope.stores)) {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(store) || !nonblank(sellerId) ||
        sellerId !== sellerId.trim() || sellers.has(sellerId)) throw Error('INVALID_STORE_BINDING');
    sellers.add(sellerId);
  }

  const products = new Set();
  for (const product of scope.products) {
    if (!hasOnly(product, ['store', 'id', 'changes']) || typeof product.store !== 'string' ||
        !Object.hasOwn(scope.stores, product.store) || !positive(product.id)) throw Error('INVALID_PRODUCT');
    const key = `${product.store}:${product.id}`;
    if (products.has(key)) throw Error('DUPLICATE_PRODUCT');
    products.add(key);
    validateChanges(product.changes);
  }
  return { sha256: digest(bytes), ...scope };
}

function validateChanges(changes) {
  if (!hasOnly(changes, ['attributes', 'trade', 'sample']) || !Object.keys(changes).length) {
    throw Error('INVALID_PRODUCT_CHANGES');
  }
  if (changes.attributes !== undefined) {
    const attrs = changes.attributes;
    if (!Array.isArray(attrs) || !attrs.length || attrs.some(attr =>
      !hasOnly(attr, ['operationType', 'attrNameId', 'attrName', 'attrValueId', 'attrValue']) ||
      !operation(attr.operationType) || !positive(attr.attrNameId) || !nonblank(attr.attrName) ||
      !nonblank(attr.attrValue) || (attr.attrValueId !== undefined && !positive(attr.attrValueId)))) {
      throw Error('INVALID_ATTRIBUTE_PATCH');
    }
  }
  if (changes.trade !== undefined) {
    const trade = changes.trade;
    if (!hasOnly(trade, ['saleType', 'moq', 'ladderPrices']) || !Object.keys(trade).length ||
        (trade.saleType !== undefined && trade.saleType !== 'normal') ||
        (trade.moq !== undefined && !positive(trade.moq))) throw Error('INVALID_TRADE_PATCH');

    const ladder = trade.ladderPrices;
    if (ladder !== undefined && (!Array.isArray(ladder) || !ladder.length || ladder.some((tier, index) =>
      !hasOnly(tier, ['operationType', 'ladderIndex', 'minQuantity', 'maxQuantity', 'unitPrice']) ||
      !operation(tier.operationType) || tier.ladderIndex !== index || !positive(tier.minQuantity) ||
      (tier.maxQuantity !== undefined && (!positive(tier.maxQuantity) || tier.maxQuantity < tier.minQuantity)) ||
      typeof tier.unitPrice !== 'string' || !price(tier.unitPrice) || price(tier.unitPrice) === '0.00' ||
      (index > 0 && (ladder[index - 1].maxQuantity ?? Infinity) >= tier.minQuantity)))) {
      throw Error('INVALID_LADDER_PATCH');
    }
  }
  if (changes.sample !== undefined && changes.sample !== false) throw Error('INVALID_SAMPLE_PATCH');
}

export function writeSteps({ id, changes }) {
  const steps = [];
  if (changes.attributes) steps.push(['attributes', { productId: id, attr: changes.attributes }]);
  if (changes.trade) steps.push(['trade', { productId: id, ...changes.trade }]);
  if (changes.sample === false) steps.push(['sample', { productId: id, supportSample: false }]);
  return [...steps, ['submit', { productId: id }]];
}

export function readArgs({ id, changes }) {
  return {
    productId: id,
    queryType: 'trunk',
    componentList: [
      ...(changes.sample === false ? ['sample'] : []),
      ...(changes.attributes ? ['attr'] : []),
      ...['saleType', 'moq', 'ladderPrices'].filter(key => changes.trade?.[key] !== undefined)
    ]
  };
}

export function matchesOnline({ id, changes }, product) {
  if (!object(product) || String(product.productId) !== String(id)) return false;
  if (changes.sample === false && product.sample?.supportSample !== false) return false;

  const actualAttrs = product.basicInfo?.attr;
  if (changes.attributes && (!Array.isArray(actualAttrs) || !changes.attributes.every(expected =>
    actualAttrs.some(actual => actual?.attrNameId === expected.attrNameId && actual.attrValue === expected.attrValue &&
      (expected.attrValueId === undefined || actual.attrValueId === expected.attrValueId))))) return false;

  const expectedTrade = changes.trade;
  const actualTrade = product.trade;
  if (!expectedTrade) return true;
  if (['saleType', 'moq'].some(key => expectedTrade[key] !== undefined && expectedTrade[key] !== actualTrade?.[key])) {
    return false;
  }
  const expectedLadder = expectedTrade.ladderPrices;
  const actualLadder = actualTrade?.ladderPrices;
  return !expectedLadder || (Array.isArray(actualLadder) && expectedLadder.length === actualLadder.length &&
    expectedLadder.every(expected => actualLadder.some(actual =>
      actual?.ladderIndex === expected.ladderIndex && actual.minQuantity === expected.minQuantity &&
      (actual.maxQuantity ?? null) === (expected.maxQuantity ?? null) &&
      price(actual.unitPrice) === price(expected.unitPrice))));
}
