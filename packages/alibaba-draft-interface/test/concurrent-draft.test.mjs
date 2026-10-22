import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createConcurrentDraftAdapter, STORE_BINDINGS } from '../similar-draft.mjs';

import { syntheticModel } from './synthetic-model.mjs';
async function harness({ wrongSeller = false, unknownFirst = false, shop = 'primary_test', sourceId = 401, count = 2 } = {}) {
  const model = syntheticModel();
  model.models.global.id = sourceId;
  model.models.global.adminAliId = STORE_BINDINGS[shop].sellerId;
  const posts = [], drafts = new Map();
  let active = 0, peak = 0;
  const response = data => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
  const context = vm.createContext({ window: {}, URL, URLSearchParams, structuredClone, performance, setTimeout, fetch: async (url, options = {}) => {
    const u = new URL(url);
    if (u.pathname.endsWith('sellerProfileAjax.do')) return response({ adminAliId: wrongSeller ? 1 : STORE_BINDINGS[shop].sellerId, minisite: STORE_BINDINGS[shop].minisite });
    if (u.pathname.endsWith('publish.htm')) return { ok: true, text: async () => "tokenName: 'X-XSRF-TOKEN', tokenValue: 'local-test-only' /posting/main-cgs/7.1.124/publish-splitpacking.js" };
    if (u.pathname.endsWith('asyRender.json')) {
      const id = Number(u.searchParams.get('itemId'));
      const m = structuredClone(model);
      m.models.global.id = id;
      if (drafts.has(id)) { m.models.formValues = drafts.get(id); m.models.global.pubAction = 'draft'; }
      return response({ success: true, data: { noIcmpResult: m } });
    }
    assert.equal(u.pathname, '/product/submitDraft.json');
    assert.equal(options.method, 'POST');
    const body = JSON.parse(new URLSearchParams(options.body).get('jsonBody'));
    const ordinal = posts.length;
    posts.push(body); active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active--;
    if (unknownFirst && ordinal === 0) throw new TypeError('simulated response loss');
    const id = 701 + ordinal;
    drafts.set(id, body);
    return response({ models: { globalMessage: { type: 'success', successUrl: '/product/publish.htm?itemId=' + id + '&pubAction=draft' } } });
  } });
  const cdp = { async send(method, { expression }) { return { result: { value: JSON.parse(JSON.stringify(await vm.runInContext(expression, context))) } }; } };
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dadb-concurrent-'));
  const adapter = await createConcurrentDraftAdapter({ cdp, runDir, shop, sourceId, count });
  return { adapter, posts, context, runDir, cdp, peak: () => peak };
}

test('two independent payloads overlap and retain per-job IDs and readback', async () => {
  const h = await harness();
  const prepared = await h.adapter.prepare();
  assert.ok(prepared.every(x => x.status === 'fulfilled'));
  const saved = await h.adapter.saveOnce();
  assert.equal(h.posts.length, 2); assert.equal(h.peak(), 2);
  assert.equal(new Set(h.posts.map(x => JSON.parse(x.extraData).uniqueId)).size, 2);
  assert.equal(new Set(saved.map(x => x.value.newDraftId)).size, 2);
  assert.ok(Math.min(...saved.map(x => x.endedMs)) > Math.max(...saved.map(x => x.startedMs)));
  const readback = await h.adapter.readback();
  assert.deepEqual(readback.map(x => x.value.newDraftId), saved.map(x => x.value.newDraftId));
  assert.ok(readback.every(x => x.value.draftGlobal.pubAction === 'draft'));
  await assert.rejects(h.adapter.saveOnce(), /EEXIST/);
  const resumed = await createConcurrentDraftAdapter({ cdp: h.cdp, runDir: h.runDir });
  await assert.rejects(resumed.saveOnce(), /EEXIST/);
  assert.equal(h.posts.length, 2);
});

test('new/old store manifests use their own source and reject the wrong live seller', async () => {
  for (const [shop, sourceId] of [['secondary_a', 501], ['secondary_b', 601]]) {
    const h = await harness({ shop, sourceId, count: 1 });
    assert.equal((await h.adapter.prepare())[0].status, 'fulfilled');
    assert.equal((await h.adapter.preflight())[0].status, 'fulfilled');
    const saved = await h.adapter.saveOnce({ startAt: Date.now() + 20 });
    assert.equal(h.posts.length, 1);
    assert.equal(saved[0].value.status, 'saved_pending_readback');
    const wrong = await harness({ shop, sourceId, count: 1, wrongSeller: true });
    assert.equal((await wrong.adapter.prepare())[0].status, 'rejected');
    assert.equal(wrong.posts.length, 0);
  }
});

test('one unknown outcome preserves sibling success and cannot be retried', async () => {
  const h = await harness({ unknownFirst: true });
  await h.adapter.prepare();
  const saved = await h.adapter.saveOnce();
  assert.equal(saved[0].value.status, 'unknown_transport_result');
  assert.equal(saved[1].value.status, 'saved_pending_readback');
  const receipt = await h.adapter.receipt();
  assert.equal(receipt[0].value.status, 'unknown_transport_result');
  assert.equal(receipt[1].value.newDraftId, saved[1].value.newDraftId);
  await assert.rejects(h.adapter.saveOnce(), /EEXIST/);
  assert.equal(h.posts.length, 2);
});

test('wrong seller or duplicate preparation never starts a save', async () => {
  const h = await harness({ wrongSeller: true });
  assert.ok((await h.adapter.prepare()).every(x => x.status === 'rejected' && /seller_mismatch/.test(x.error)));
  await assert.rejects(h.adapter.saveOnce(), /unknown_reconcile/);
  assert.equal(h.posts.length, 0);
  const clean = await harness();
  const preparations = await Promise.allSettled([clean.adapter.prepare(), clean.adapter.prepare()]);
  assert.equal(preparations.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(preparations.filter(x => x.status === 'rejected').length, 1);
  assert.equal(clean.posts.length, 0);
});
