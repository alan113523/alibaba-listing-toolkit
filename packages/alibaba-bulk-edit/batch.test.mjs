import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { apply, preview, reconcile, status } from './batch.mjs';
import demo from './demo-transport.mjs';
import { tools } from './plan.mjs';

const example = new URL('./scope.example.json', import.meta.url);
const twoHours = 7_200_000;

function fixture(t, products) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-edit-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scope = JSON.parse(fs.readFileSync(example, 'utf8'));
  if (products) scope.products = products;
  const scopePath = path.join(directory, 'scope.json');
  const runDir = path.join(directory, 'state');
  const updateScope = () => fs.writeFileSync(scopePath, JSON.stringify(scope));
  updateScope();
  const options = { scopePath, runDir };
  const calls = [];
  const transport = {
    getSellerId: demo.getSellerId,
    async invoke(call) {
      calls.push(call);
      return demo.invoke(call);
    }
  };
  return { scope, options, transport, calls, updateScope,
    execution: { ...options, transport, approvedSha256: preview(options).sha256 } };
}

test('combined, price-only and sample-only edits submit once and reconcile only changed fields', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { options, execution, calls } = fixture(t);
  assert.deepEqual(status(options).counts, { 'not-started': 3 });
  const report = await apply(execution);
  assert.deepEqual(report.counts, { 'pending-verification': 3 });
  const callsFor = id => calls.filter(call => call.args.productId === id);
  const namesFor = id => callsFor(id).map(call => call.tool);
  assert.deepEqual(namesFor(101), [tools.attributes, tools.trade, tools.sample, tools.submit]);
  assert.deepEqual(namesFor(102), [tools.trade, tools.submit]);
  assert.deepEqual(namesFor(103), [tools.sample, tools.submit]);

  const intentPath = path.join(options.runDir, 'products', 'store-demo-a', '101', 'attributes.intent.json');
  const intent = JSON.parse(fs.readFileSync(intentPath, 'utf8'));
  assert.equal(intent.callId, callsFor(101)[0].callId);
  assert.match(intent.requestSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(intent), ['callId', 'requestSha256', 'startedAt']);

  t.mock.timers.tick(twoHours - 1);
  await assert.rejects(reconcile(execution), /VERIFICATION_NOT_DUE/);
  assert.equal(calls.filter(call => call.tool === tools.query).length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual((await reconcile(execution)).counts, { verified: 3 });
  assert.deepEqual(callsFor(101).at(-1).args, {
    productId: 101, queryType: 'trunk', componentList: ['sample', 'attr', 'saleType', 'moq']
  });
  assert.deepEqual(callsFor(102).at(-1).args.componentList, ['ladderPrices']);
  assert.deepEqual(callsFor(103).at(-1).args.componentList, ['sample']);
  const before = calls.length;
  await apply(execution);
  await reconcile(execution);
  assert.equal(calls.length, before);

  fs.unlinkSync(path.join(options.runDir, 'products', 'store-demo-a', '101', 'submit.receipt.json'));
  assert.equal(status(options).products[0].status, 'unknown-write');
  await apply(execution);
  assert.equal(calls.length, before);
});

test('unknown submit remains unknown after matching formal fields, validation failure stays rejected', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { execution, transport, calls } = fixture(t);
  const normal = transport.invoke;
  transport.invoke = async call => {
    if (call.tool === tools.submit && call.args.productId === 101) {
      calls.push(call);
      throw Error('lost vendor response');
    }
    if (call.tool === tools.trade && call.args.productId === 102) {
      calls.push(call);
      return { success: true, data: 'Attribute value cannot be blank.' };
    }
    return normal(call);
  };
  const first = await apply(execution);
  assert.equal(first.stopped, 'TRANSPORT_FAILURE');
  assert.equal(first.counts['unknown-write'], 1);
  const second = await apply(execution);
  assert.deepEqual(second.counts, { 'unknown-write': 1, rejected: 1, 'pending-verification': 1 });
  t.mock.timers.tick(twoHours);
  const final = await reconcile(execution);
  assert.equal(final.products[0].lastReadback.fieldsMatch, true);
  assert.equal(final.products[0].status, 'unknown-write');
  assert.equal(final.products[1].status, 'rejected');
  assert.equal(final.products[2].status, 'verified');
  assert.equal(calls.filter(call => call.tool === tools.submit && call.args.productId === 101).length, 1);
  assert.equal(calls.filter(call => call.tool === tools.submit && call.args.productId === 102).length, 0);

  const priceOnly = JSON.parse(fs.readFileSync(example, 'utf8')).products[1];
  const sibling = fixture(t, [priceOnly]);
  const before = calls.length;
  const blocked = await apply({ ...sibling.execution, transport, runDir: `${execution.runDir}-other` });
  assert.equal(blocked.stopped, 'PRODUCT_OWNED_BY_ANOTHER_BATCH');
  assert.equal(calls.length, before);
});

test('shop identity is checked around calls and a confirmed edit resumes only the missing step', async t => {
  const product = { store: 'demo-b', id: 103, changes: { sample: false } };
  const { transport, execution, calls } = fixture(t, [product]);
  let idChecks = 0;
  transport.getSellerId = async () => ++idChecks === 3 ? 'wrong-seller' : 'synthetic-seller-b';
  const first = await apply(execution);
  assert.equal(first.stopped, 'SELLER_IDENTITY_MISMATCH');
  assert.deepEqual(first.counts, { 'partially-edited': 1 });
  assert.equal(first.schedule, null);
  assert.deepEqual(calls.map(call => call.tool), [tools.sample]);
  const second = await apply(execution);
  assert.deepEqual(second.counts, { 'pending-verification': 1 });
  assert.deepEqual(calls.map(call => call.tool), [tools.sample, tools.submit]);
  assert.equal(idChecks, 5);
});

test('wrong account after dispatch keeps the outcome unknown and stops further writes', async t => {
  const { transport, execution, calls } = fixture(t, [{ store: 'demo-b', id: 103, changes: { sample: false } }]);
  let checks = 0;
  transport.getSellerId = async () => ++checks === 1 ? 'synthetic-seller-b' : 'changed-seller';
  assert.deepEqual((await apply(execution)).counts, { 'unknown-write': 1 });
  assert.deepEqual((await apply(execution)).counts, { 'unknown-write': 1 });
  assert.deepEqual(calls.map(call => call.tool), [tools.sample]);
});

test('missing or wrong original product and tier bounds keep verification pending', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const priceOnly = JSON.parse(fs.readFileSync(example, 'utf8')).products[1];
  const { transport, execution } = fixture(t, [priceOnly]);
  await apply(execution);
  t.mock.timers.tick(twoHours);
  let reply;
  transport.invoke = async () => ({ success: true, data: JSON.stringify(reply) });
  reply = { trade: structuredClone(priceOnly.changes.trade) };
  assert.deepEqual((await reconcile(execution)).counts, { 'pending-verification': 1 });
  reply.productId = 101;
  assert.deepEqual((await reconcile(execution)).counts, { 'pending-verification': 1 });
  reply.productId = '102';
  reply.trade.ladderPrices[1].maxQuantity = 99;
  assert.deepEqual((await reconcile(execution)).counts, { 'pending-verification': 1 });
  delete reply.trade.ladderPrices[1].maxQuantity;
  reply.trade.ladderPrices[1].unitPrice = 7.5;
  assert.deepEqual((await reconcile(execution)).counts, { verified: 1 });
});

test('approval freezes scope, detects changed bytes and rejects a concurrent apply', async t => {
  const { scope, options, transport, execution, calls, updateScope } = fixture(t);
  await assert.rejects(apply({ ...execution, approvedSha256: 'wrong' }), /SCOPE_APPROVAL_MISMATCH/);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(options.runDir), false);
  let unblock;
  const hold = new Promise(resolve => { unblock = resolve; });
  const normal = transport.invoke;
  transport.invoke = async call => { await hold; return normal(call); };
  const active = apply(execution);
  try {
    await assert.rejects(apply(execution), /BATCH_LOCKED/);
  } finally {
    unblock();
    await active;
  }
  scope.products[0].changes.trade.moq++;
  updateScope();
  await assert.rejects(apply({ ...execution, approvedSha256: preview(options).sha256 }), /SCOPE_CHANGED/);
  scope.products.push(scope.products[0]);
  updateScope();
  assert.throws(() => preview(options), /DUPLICATE_PRODUCT/);
  scope.products.pop();
  scope.products[1].changes.trade.ladderPrices[0].maxQuantity = 10;
  updateScope();
  assert.throws(() => preview(options), /INVALID_LADDER_PATCH/);
});

test('global and per-store worker limits hold while an operator drains the queue', async t => {
  const products = ['demo-a', 'demo-b'].flatMap(store => [1, 2, 3, 4, 5].map(id =>
    ({ store, id, changes: { sample: false } })));
  const { execution, transport, options } = fixture(t, products);
  const active = new Map();
  let peak = 0;
  let peakPerStore = 0;
  let calls = 0;
  const drain = path.join(options.runDir, 'drain-request.json');
  transport.invoke = async ({ store, tool }) => {
    active.set(store, (active.get(store) ?? 0) + 1);
    peak = Math.max(peak, [...active.values()].reduce((sum, count) => sum + count, 0));
    peakPerStore = Math.max(peakPerStore, active.get(store));
    if (++calls === 3) fs.writeFileSync(drain, '{}');
    await setImmediate();
    active.set(store, active.get(store) - 1);
    return { success: true, data: tool === tools.submit ? 'submit draft success' : 'draft edit success' };
  };
  const limits = { ...execution, concurrencyPerStore: 2, maxConcurrent: 3 };
  const first = await apply(limits);
  assert.equal(peak, 3);
  assert.equal(peakPerStore, 2);
  assert.equal(first.stopped, 'DRAIN_REQUESTED');
  assert.deepEqual(first.counts, { 'pending-verification': 3, 'not-started': 7 });
  assert.equal(first.schedule, null);
  fs.unlinkSync(drain);
  assert.deepEqual((await apply(limits)).counts, { 'pending-verification': 10 });
});

test('sibling runs share seller-and-product ownership until official verification', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { execution, transport, calls } = fixture(t, [{ store: 'demo-b', id: 103, changes: { sample: false } }]);
  const sibling = { ...execution, runDir: `${execution.runDir}-other` };
  const normal = transport.invoke;
  let signalStarted;
  let release;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  transport.invoke = async call => {
    signalStarted();
    await held;
    return normal(call);
  };
  const first = apply(execution);
  try {
    await started;
    const blocked = await apply(sibling);
    assert.equal(blocked.stopped, 'PRODUCT_OWNED_BY_ANOTHER_BATCH');
    assert.deepEqual(blocked.counts, { 'not-started': 1 });
  } finally {
    release();
    await first;
  }
  assert.equal((await apply(sibling)).stopped, 'PRODUCT_OWNED_BY_ANOTHER_BATCH');
  assert.deepEqual(calls.map(call => call.tool), [tools.sample, tools.submit]);
  t.mock.timers.tick(twoHours);
  assert.deepEqual((await reconcile(execution)).counts, { verified: 1 });
  assert.deepEqual((await apply(sibling)).counts, { 'pending-verification': 1 });
});

test('a sibling run cannot reissue an unknown write even after matching readback', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { execution, transport } = fixture(t, [{ store: 'demo-b', id: 103, changes: { sample: false } }]);
  const normal = transport.invoke;
  transport.invoke = async call => {
    if (call.tool === tools.submit) throw Error('lost response');
    return normal(call);
  };
  await apply(execution);
  t.mock.timers.tick(twoHours);
  const report = await reconcile(execution);
  assert.equal(report.products[0].lastReadback.fieldsMatch, true);
  assert.deepEqual(report.counts, { 'unknown-write': 1 });
  const blocked = await apply({ ...execution, runDir: `${execution.runDir}-other` });
  assert.equal(blocked.stopped, 'PRODUCT_OWNED_BY_ANOTHER_BATCH');
});

test('a conflicting range stops before any write and rolls back its unused reservations', async t => {
  const product = id => ({ store: 'demo-b', id, changes: { sample: false } });
  const first = fixture(t, [product(1)]);
  const second = fixture(t, [product(2), product(1)]);
  const third = fixture(t, [product(2)]);
  const calls = [];
  const transport = {
    getSellerId: demo.getSellerId,
    async invoke(call) {
      calls.push(call.args.productId);
      return { success: true, data: call.tool === tools.submit ? 'submit draft success' : 'draft edit success' };
    }
  };
  await apply({ ...first.execution, transport });
  const stopped = await apply({ ...second.execution, transport, runDir: `${first.options.runDir}-second` });
  assert.equal(stopped.stopped, 'PRODUCT_OWNED_BY_ANOTHER_BATCH');
  assert.deepEqual(stopped.counts, { 'not-started': 2 });
  assert.deepEqual(calls, [1, 1]);
  const other = await apply({ ...third.execution, transport, runDir: `${first.options.runDir}-third` });
  assert.deepEqual(other.counts, { 'pending-verification': 1 });
  assert.deepEqual(calls, [1, 1, 2, 2]);
});
