import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { prepareAsset, createUploader as createConfiguredUploader, resolveImage, connectBuiltinChrome, connectBuiltinChromeStores, uploadAcrossStores, assertStoreModel, STORES, DADB } from '../index.mjs';
import { adoptExistingDetail } from '../existing-details.mjs';

// Existing full-gallery coverage remains an explicit strategy; default-platform cases opt out below.
const createUploader = options => createConfiguredUploader({ dedupeStrategy: 'full', ...options });

const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const md5 = b => crypto.createHash('md5').update(b).digest('hex');
async function fixture(t, slot = 'MAIN03', fill = 7) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobank-test-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'photobank-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const bytes = Buffer.alloc(120000, fill);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  bytes.write('IHDR', 12); bytes.writeUInt32BE(1254, 16); bytes.writeUInt32BE(1254, 20);
  const local = path.join(root, 'SYNTH-N_T01_' + slot + '.png');
  const approval = path.join(root, 'approval.json'), indexPath = path.join(root, 'index.json');
  await fs.writeFile(local, bytes);
  const relativePath = 'SYNTH-N/T01/SYNTH-N_T01_' + slot + '.png';
  const evidence = Buffer.from(JSON.stringify({ status: 'user_approved', files: [{ path: relativePath, sha256: hash(bytes) }] }));
  await fs.writeFile(approval, evidence);
  await fs.writeFile(indexPath, JSON.stringify([{ model: 'SYNTH-N', variant: '标准款', template: 'T01', slot, relative_path: relativePath, local_path: local, sha256: hash(bytes), bytes: bytes.length, width: 1254, height: 1254, user_approval: 'approved', approval_evidence: approval, approval_evidence_sha256: hash(evidence) }]));
  return { root, bytes, local, approval, indexPath, relativePath, stateDir: path.join(root, 'state') };
}

function fakeBrowser(f, opts = {}) {
  const store = opts.store || DADB;
  const assets = opts.assets || [f];
  const filename = asset => (opts.assets ? 'A' + md5(asset.bytes) : 'ATEST') + (opts.receiptExtension || path.extname(asset.local));
  const calls = [], db = opts.items ? [...opts.items] : [];
  let lost = false, filePosts = 0, registerPosts = 0;
  const item = (id = opts.imageId || 1001, groupId = store.groupId, asset = f) => ({ id, filename: filename(asset), displayName: path.basename(asset.local, path.extname(asset.local)), groupId, memberSeq: store.memberSeq, imageUrl: '//sc04.alicdn.com/kf/' + filename(asset), gmtCreate: '2026-10-21T01:00:00Z', photobankImageMetadata: { hashCode: md5(asset.bytes), size: asset.bytes.length, width: 1254, height: 1254 } });
  if (opts.existing) db.push(item());
  const response = (data, bytes) => ({ ok: true, status: 200, json: async () => data, arrayBuffer: async () => Uint8Array.from(bytes).buffer });
  const ctx = vm.createContext({
    URL, Uint8Array, File, FormData, crypto: crypto.webcrypto, atob, setTimeout, clearTimeout,
    location: { origin: opts.origin || 'https://photobank.alibaba.com' },
    window: { AWSC: { configFY: cb => cb({ getUA: () => 'synthetic-ua', umidToken: 'synthetic-umid' }) } },
    document: { cookie: 'xman_us_t=ctoken=synthetic-csrf; _tb_token_=synthetic-tb', getElementsByName: () => [] },
    fetch: async (raw, init = {}) => {
      const u = new URL(raw, 'https://photobank.alibaba.com');
      calls.push({ method: init.method || 'GET', endpoint: u.origin + u.pathname,
        ...(u.pathname === '/fetch/bank' ? { search: JSON.parse(u.searchParams.get('search')) } : {}) });
      if (u.pathname === '/ajax/sellerProfileAjax.do') return response({ adminAliId: opts.wrongSeller ? 99 : store.aliId, adminMbrSeq: store.memberSeq, minisite: store.minisite });
      if (u.pathname === '/fetch/groups/-1') return response({ success: true, data: [{ id: store.groupId, name: opts.wrongGroup ? 'wrong' : store.groupName, aliMemberId: store.memberSeq }, ...(opts.extraGroups || [])] });
      if (u.pathname === '/fetch/bank') {
        const group = JSON.parse(u.searchParams.get('search')).groupId;
        const list = db.filter(x => String(group) === '-1' || String(x.groupId) === String(group));
        const size = Number(u.searchParams.get('pageSize')), page = Number(u.searchParams.get('page'));
        if (opts.pageHook) await opts.pageHook(page);
        return response({ success: true, data: { total: opts.hugeTotal ? 999999 : list.length, list: list.slice((page - 1) * size, page * size), currentPage: opts.wrongPage ? 1 : page } });
      }
      if (u.origin === 'https://filebroker.alibaba.com') {
        filePosts++;
        if (opts.uploadBarrier) await opts.uploadBarrier();
        const b = Buffer.from(await init.body.get('file').arrayBuffer());
        const asset = assets.find(a => hash(a.bytes) === hash(b));
        assert.ok(asset, 'POST must contain an approved fixture');
        assert.equal(init.body.get('file').type, /\.jpe?g$/i.test(asset.local) ? 'image/jpeg' : 'image/png');
        assert.equal(init.body.get('bizCode'), 'icbu_photobank');
        return response({ code: 0, filename: filename(asset), url: 'https://sc01.alicdn.com/kf/' + filename(asset), hash: opts.badUploadHash || opts.failUploadHash === md5(b) ? 'wrong' : md5(b), size: b.length, width: 1254, height: 1254 });
      }
      if (u.pathname === '/fetch/bank/photo/upload') {
        registerPosts++;
        assert.equal(u.origin, 'https://photobank.alibaba.com');
        assert.equal(u.searchParams.get('ctoken'), 'synthetic-csrf');
        const body = JSON.parse(init.body);
        assert.equal(body.groupId, String(store.groupId));
        assert.equal(body.useWatermark, false);
        assert.equal(body.imgListData.length, 1);
        const asset = assets.find(a => md5(a.bytes) === body.imgListData[0].fileMd5);
        assert.ok(asset);
        if (opts.duplicateRegistration) return response({ success: true, code: 200, data: { duplicateList: [{ unknownPlatformField: 12345 }] } });
        db.push(item(opts.assets ? 1001 + assets.indexOf(asset) : undefined, store.groupId, asset));
        return response({ success: true, code: 200, data: { duplicateList: [] } });
      }
      if (/^sc\d+\.alicdn\.com$/.test(u.hostname)) {
        const asset = assets.find(a => u.pathname.endsWith('/' + filename(a)));
        return response(null, opts.badCdn ? Buffer.from('changed') : asset.bytes);
      }
      throw Error('Unexpected request: ' + u.origin + u.pathname);
    }
  });
  const cdp = { send: async (method, params) => {
    assert.equal(method, 'Runtime.evaluate');
    assert.ok(params.expression.length < 90000, 'no oversized native message');
    let value;
    try { value = await vm.runInContext(params.expression, ctx); }
    catch (e) { return { exceptionDetails: { exception: { description: String(e) } } }; }
    if (!lost && ((opts.loseAfterUpload && value?.phase === 'file_uploaded' && params.expression.includes('"op":"upload"')) || (opts.loseAfterRegister && value?.phase === 'registered'))) {
      lost = true;
      throw Error('synthetic connection lost after remote effect');
    }
    return { result: { value: value == null ? value : JSON.parse(JSON.stringify(value)) } };
  } };
  return { cdp, calls, db, item, counts: () => ({ filePosts, registerPosts }), ctx };
}

test('full flow transfers bounded chunks, registers once, resolves frozen listing reference and reuses on second run', async t => {
  const f = await fixture(t), b = fakeBrowser(f);
  const runner = createUploader({ cdp: b.cdp, stateDir: f.stateDir });
  const a = await runner.uploadApproved(f);
  assert.equal(a.action, 'uploaded_new');
  assert.equal(a.mapping.platform_image_id, 1001);
  assert.deepEqual(b.counts(), { filePosts: 1, registerPosts: 1 });
  assert.equal(b.ctx.window.__codexPhotobankUploadsV1, undefined);
  const second = await runner.uploadApproved(f);
  assert.equal(second.action, 'reused_existing');
  assert.deepEqual(b.counts(), { filePosts: 1, registerPosts: 1 });
  const ref = await resolveImage({ sha256: hash(f.bytes), model: 'SYNTH-N', variant: '标准款', stateDir: f.stateDir });
  assert.equal(ref.platform_image_id, 1001);
  await assert.rejects(resolveImage({ sha256: hash(f.bytes), model: 'SYNTH-N', variant: 'other', stateDir: f.stateDir }), /mapping_identity_or_variant_mismatch/);
});

test('read-only reuse never issues POST and scans beyond first page', async t => {
  const f = await fixture(t), b = fakeBrowser(f, { existing: true });
  const padding = [2,3,4].map(id => ({ ...b.item(id), displayName: 'other' + id, photobankImageMetadata: { ...b.item(id).photobankImageMetadata, hashCode: 'other' + id } }));
  b.db.unshift(...padding);
  const r = await createUploader({ cdp: b.cdp, stateDir: f.stateDir, pageSize: 2 }).uploadApproved({ ...f, reuseOnly: true });
  assert.equal(r.action, 'reused_existing');
  assert.deepEqual(b.counts(), { filePosts: 0, registerPosts: 0 });
});

for (const [name, options, code] of [
  ['wrong seller', { wrongSeller: true }, 'seller_identity_mismatch'],
  ['wrong directory', { wrongGroup: true }, 'target_group_mismatch'],
  ['incomplete dedupe budget', { hugeTotal: true }, 'dedupe_page_budget_exceeded'],
  ['corrupt uploaded hash', { badUploadHash: true }, 'file_upload_failed_or_uncertain'],
  ['corrupt CDN image', { existing: true, badCdn: true }, 'cdn_bytes_mismatch']
]) test(name + ' stops before unsafe progression', async t => {
  const f = await fixture(t), b = fakeBrowser(f, options);
  await assert.rejects(createUploader({ cdp: b.cdp, stateDir: f.stateDir }).uploadApproved(f), new RegExp(code));
  assert.equal(b.counts().registerPosts, 0);
  if (!options.badUploadHash) assert.equal(b.counts().filePosts, 0);
});

test('changed approved bytes or changed approval document never reach browser', async t => {
  const f = await fixture(t);
  await fs.appendFile(f.local, 'changed');
  await assert.rejects(prepareAsset(f), /approved_file_changed/);
  await fs.writeFile(f.local, f.bytes);
  await fs.appendFile(f.approval, ' ');
  await assert.rejects(prepareAsset(f), /approval_evidence_changed/);
});

test('duplicate in another directory is reported without upload or move', async t => {
  const f = await fixture(t), b = fakeBrowser(f);
  b.db.push(b.item(1001, 42));
  await assert.rejects(createUploader({ cdp: b.cdp, stateDir: f.stateDir }).uploadApproved(f), /duplicate_outside_target/);
  assert.deepEqual(b.counts(), { filePosts: 0, registerPosts: 0 });
});

test('same filename with different content is not silently reused or overwritten', async t => {
  const f = await fixture(t), b = fakeBrowser(f);
  b.db.push({ ...b.item(), photobankImageMetadata: { ...b.item().photobankImageMetadata, hashCode: 'different' } });
  await assert.rejects(createUploader({ cdp: b.cdp, stateDir: f.stateDir }).uploadApproved(f), /platform_name_conflict/);
  assert.deepEqual(b.counts(), { filePosts: 0, registerPosts: 0 });
});

test('lost response after registration reconciles existing image without repeating POST', async t => {
  const f = await fixture(t), b = fakeBrowser(f, { loseAfterRegister: true });
  const runner = createUploader({ cdp: b.cdp, stateDir: f.stateDir });
  await assert.rejects(runner.uploadApproved(f), /browser_command_failed/);
  assert.equal((await runner.uploadApproved(f)).action, 'reused_existing');
  assert.deepEqual(b.counts(), { filePosts: 1, registerPosts: 1 });
});

test('lost response after file upload reuses its confirmed browser receipt', async t => {
  const f = await fixture(t), b = fakeBrowser(f, { loseAfterUpload: true });
  const runner = createUploader({ cdp: b.cdp, stateDir: f.stateDir });
  await assert.rejects(runner.uploadApproved(f), /browser_command_failed/);
  assert.equal((await runner.uploadApproved(f)).action, 'uploaded_new');
  assert.deepEqual(b.counts(), { filePosts: 1, registerPosts: 1 });
});

test('unknown file POST outcome cannot be retried after browser state is lost', async t => {
  const f = await fixture(t), b = fakeBrowser(f, { loseAfterUpload: true });
  const runner = createUploader({ cdp: b.cdp, stateDir: f.stateDir });
  await assert.rejects(runner.uploadApproved(f), /browser_command_failed/);
  delete b.ctx.window.__codexPhotobankUploadsV1;
  await assert.rejects(runner.uploadApproved(f), /file_post_uncertain_no_retry/);
  assert.deepEqual(b.counts(), { filePosts: 1, registerPosts: 0 });
});

test('store lock blocks overlapping upload jobs', async t => {
  const f = await fixture(t), b = fakeBrowser(f);
  await fs.mkdir(path.join(f.stateDir, 'primary_test'), { recursive: true });
  await fs.writeFile(path.join(f.stateDir, 'primary_test/upload.lock'), 'synthetic occupied lock');
  await assert.rejects(createUploader({ cdp: b.cdp, stateDir: f.stateDir }).uploadApproved(f), /store_upload_locked/);
  assert.equal(b.calls.length, 0);
});

test('connector rejects external CDP backends before claiming a tab', async () => {
  const cua = { listBrowsers: async () => [{ id: 'x', type: 'cdp', family: 'chrome' }] };
  await assert.rejects(connectBuiltinChrome({ cua, browserId: 'x', tabId: '1' }), /builtin_chrome_extension_required/);
});

test('three stores overlap file POSTs, preserve independent identities and mappings, and resolve per shop', async t => {
  const f = await fixture(t);
  let arrivals = 0, release;
  const ready = new Promise(r => { release = r; });
  const uploadBarrier = async () => { if (++arrivals === 3) release(); await ready; };
  const browsers = Object.values(STORES).map((store, i) => fakeBrowser(f, { store, imageId: 1001 + i, uploadBarrier, origin: i === 2 ? 'https://hz-productposting.alibaba.com' : undefined }));
  const tasks = Object.keys(STORES).map((shopId, i) => ({ ...f, requireNew: true, uploader: createUploader({ shopId, cdp: browsers[i].cdp, stateDir: f.stateDir }) }));
  const result = await uploadAcrossStores({ tasks });
  assert.equal(arrivals, 3);
  assert.equal(result.ok, true);
  for (let i = 0; i < tasks.length; i++) {
    assert.deepEqual(browsers[i].counts(), { filePosts: 1, registerPosts: 1 });
    const ref = await resolveImage({ shopId: tasks[i].uploader.shopId, sha256: hash(f.bytes), model: 'SYNTH-N', variant: '标准款', stateDir: f.stateDir });
    assert.equal(ref.platform_image_id, 1001 + i);
    assert.ok(ref.mapping_path.includes(tasks[i].uploader.shopId));
  }
});

test('D models are forbidden in new/old uploads and listing resolution before network or filesystem lookup', async t => {
  const f = await fixture(t);
  const entries = JSON.parse(await fs.readFile(f.indexPath, 'utf8'));
  entries[0].model = 'D-SYNTHETIC';
  await fs.writeFile(f.indexPath, JSON.stringify(entries));
  for (const shopId of ['secondary_a', 'secondary_b']) {
    const b = fakeBrowser(f, { store: STORES[shopId] }), runner = createUploader({ shopId, cdp: b.cdp, stateDir: f.stateDir });
    await assert.rejects(runner.uploadApproved(f), /d_model_forbidden/);
    await assert.rejects(runner.inspectApproved(f), /d_model_forbidden/);
    await assert.rejects(runner.uploadBatch({ jobs: [f] }), /d_model_forbidden/);
    await assert.rejects(runner.inspectBatch({ jobs: [f] }), /d_model_forbidden/);
    await assert.rejects(resolveImage({ shopId, model: 'D-SYNTHETIC', sha256: hash(f.bytes), variant: '标准款', stateDir: f.stateDir }), /d_model_forbidden/);
    assert.equal(b.calls.length, 0);
    assert.throws(() => assertStoreModel(shopId, ' ｄAC-A01'), /d_model_forbidden/);
  }
  assert.doesNotThrow(() => assertStoreModel('primary_test', 'D-SYNTHETIC'));
});

test('batch validates all models before starting any store and isolates a failed store', async t => {
  const f = await fixture(t), bad = await fixture(t);
  const entries = JSON.parse(await fs.readFile(bad.indexPath, 'utf8'));
  entries[0].model = 'D-SYNTHETIC'; await fs.writeFile(bad.indexPath, JSON.stringify(entries));
  const browsers = Object.values(STORES).map(store => fakeBrowser(f, { store, wrongSeller: store.id === 'secondary_a' }));
  const tasks = Object.keys(STORES).map((shopId, i) => ({ ...f, uploader: createUploader({ shopId, cdp: browsers[i].cdp, stateDir: f.stateDir }) }));
  await assert.rejects(uploadAcrossStores({ tasks: [tasks[0], { ...tasks[1], indexPath: bad.indexPath }, tasks[2]] }), /d_model_forbidden/);
  assert.ok(browsers.every(b => !b.calls.length));
  const result = await uploadAcrossStores({ tasks });
  assert.equal(result.ok, false);
  assert.equal(result.results[1].code, 'seller_identity_mismatch');
  assert.equal(result.results.filter(r => r.status === 'fulfilled').length, 2);
  assert.deepEqual(browsers[1].counts(), { filePosts: 0, registerPosts: 0 });
});

test('fresh-upload mode rejects duplicates and read-only inspection does not register', async t => {
  const f = await fixture(t), b = fakeBrowser(f, { existing: true });
  const runner = createUploader({ cdp: b.cdp, stateDir: f.stateDir });
  const inspection = await runner.inspectApproved(f);
  assert.equal(inspection.unuploaded, false);
  await assert.rejects(runner.uploadApproved({ ...f, requireNew: true }), /already_uploaded/);
  assert.deepEqual(b.counts(), { filePosts: 0, registerPosts: 0 });
});

test('batch connector rejects shared extension profiles before claiming tabs', async () => {
  const cua = { listBrowsers: async () => [{ id: 'x', type: 'extension', family: 'chrome', metadata: { extensionInstanceId: 'same' } }] };
  await assert.rejects(connectBuiltinChromeStores({ cua, bindings: Object.keys(STORES).map(shopId => ({ shopId, browserId: 'x', tabId: '1' })) }), /three_independent_chrome_profiles_required/);
});

test('whole-bank dedupe includes historical memberSeq records without accepting them as new target mappings', async t => {
  const f = await fixture(t), b = fakeBrowser(f);
  b.db.push({ ...b.item(1001, 42), memberSeq: 286167756 });
  const runner = createUploader({ cdp: b.cdp, stateDir: f.stateDir });
  assert.equal((await runner.inspectApproved(f)).unuploaded, false);
  await assert.rejects(runner.uploadApproved(f), /duplicate_outside_target/);
  assert.deepEqual(b.counts(), { filePosts: 0, registerPosts: 0 });
  b.db[0].groupId = DADB.groupId;
  await assert.rejects(runner.uploadApproved(f), /invalid_bank_identity_or_pagination/);
});

test('read-only pagination overlaps at most three pages and rejects a repeated page response', async t => {
  const f = await fixture(t);
  let active = 0, peak = 0;
  const b = fakeBrowser(f, { existing: true, pageHook: async page => {
    if (page === 1) return;
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 10));
    active--;
  } });
  b.db.unshift(...[2,3,4,5].map(id => ({ ...b.item(id), displayName: 'other' + id, photobankImageMetadata: { ...b.item(id).photobankImageMetadata, hashCode: 'other' + id } })));
  const runner = createUploader({ cdp: b.cdp, stateDir: f.stateDir, pageSize: 1 });
  assert.equal((await runner.uploadApproved({ ...f, reuseOnly: true })).action, 'reused_existing');
  assert.equal(peak, 3);
  const repeated = fakeBrowser(f, { items: b.db, wrongPage: true });
  await assert.rejects(createUploader({ cdp: repeated.cdp, stateDir: f.stateDir, pageSize: 1 }).uploadApproved(f), /bank_query_failed/);
  assert.deepEqual(repeated.counts(), { filePosts: 0, registerPosts: 0 });
});

test('nine images share one store lock and overlap nine distinct file POSTs with separate mappings', { timeout: 10000 }, async t => {
  const fixtures = await Promise.all(Array.from({ length: 9 }, (_, i) => fixture(t, 'MAIN' + (i + 1), i + 1)));
  const f = fixtures[0];
  let arrivals = 0, release;
  const gate = new Promise(r => { release = r; });
  const b = fakeBrowser(f, { assets: fixtures, uploadBarrier: async () => { if (++arrivals === 9) release(); await gate; } });
  let activeCommands = 0, peakCommands = 0, uploadCommands = 0, registerCommands = 0, verifyCommands = 0;
  const send = b.cdp.send;
  b.cdp.send = async (...args) => {
    activeCommands++; peakCommands = Math.max(peakCommands, activeCommands);
    if (args[1].expression.includes('"op":"upload_many"')) uploadCommands++;
    if (args[1].expression.includes('"op":"register_many"')) registerCommands++;
    if (args[1].expression.includes('"op":"verify_many"')) verifyCommands++;
    try { return await send(...args); } finally { activeCommands--; }
  };
  const runner = createUploader({ cdp: b.cdp, stateDir: f.stateDir });
  const inspection = await runner.inspectBatch({ jobs: fixtures });
  assert.ok(inspection.assets.every(a => a.unuploaded));
  const result = await runner.uploadBatch({ jobs: fixtures.map(j => ({ ...j, requireNew: true })) });
  assert.equal(result.ok, true);
  assert.equal(arrivals, 9);
  assert.equal(peakCommands, 1, 'extension messages are serialized while browser HTTP uploads overlap');
  assert.equal(uploadCommands, 1);
  assert.equal(registerCommands, 1);
  assert.equal(verifyCommands, 1);
  assert.deepEqual(result.counts, { uploaded_new: 9, reused_existing: 0, failed: 0 });
  assert.deepEqual(b.counts(), { filePosts: 9, registerPosts: 9 });
  assert.equal(new Set(result.results.map(r => r.mapping.platform_image_id)).size, 9);
  for (const r of result.results) {
    assert.equal(r.mapping.batch_id, result.batch_id);
    assert.equal((await resolveImage({ sha256: r.sha256, model: 'SYNTH-N', variant: '标准款', stateDir: f.stateDir })).platform_image_id, r.mapping.platform_image_id);
  }
  assert.equal(b.ctx.window.__codexPhotobankUploadsV1, undefined);
  await assert.rejects(fs.access(path.join(f.stateDir, 'primary_test/upload.lock')), { code: 'ENOENT' });
  const reused = await runner.uploadBatch({ jobs: fixtures });
  assert.deepEqual(reused.counts, { uploaded_new: 0, reused_existing: 9, failed: 0 });
  assert.deepEqual(b.counts(), { filePosts: 9, registerPosts: 9 });
});

test('batch rejects excess size and duplicate selections before network', async t => {
  const f = await fixture(t), b = fakeBrowser(f), runner = createUploader({ cdp: b.cdp, stateDir: f.stateDir });
  await assert.rejects(runner.uploadBatch({ jobs: Array(10).fill(f) }), /batch_size_must_be_1_to_9/);
  await assert.rejects(runner.uploadBatch({ jobs: [f, f] }), /duplicate_asset_in_batch/);
  assert.equal(b.calls.length, 0);
});

test('one failed image cannot strand the batch barrier or discard other results', { timeout: 10000 }, async t => {
  const fixtures = await Promise.all([fixture(t, 'MAIN01', 1), fixture(t, 'MAIN02', 2), fixture(t, 'MAIN03', 3)]), f = fixtures[0];
  const b = fakeBrowser(f, { assets: fixtures, failUploadHash: md5(f.bytes) });
  const runner = createUploader({ cdp: b.cdp, stateDir: f.stateDir });
  const result = await runner.uploadBatch({ jobs: fixtures });
  assert.equal(result.ok, false);
  assert.deepEqual(result.counts, { uploaded_new: 2, reused_existing: 0, failed: 1 });
  assert.deepEqual(b.counts(), { filePosts: 3, registerPosts: 2 });
  const blocked = await runner.uploadBatch({ jobs: [fixtures[1]] }).catch(e => e.code);
  assert.equal(blocked, 'pending_browser_jobs_reconcile_first');
  assert.deepEqual(b.counts(), { filePosts: 3, registerPosts: 2 });
});

test('batch keeps the store lock against unrelated calls and releases after preflight errors', async t => {
  const f = await fixture(t), b = fakeBrowser(f, { wrongSeller: true });
  const runner = createUploader({ cdp: b.cdp, stateDir: f.stateDir });
  await assert.rejects(runner.uploadBatch({ jobs: [f] }), /seller_identity_mismatch/);
  await assert.rejects(fs.access(path.join(f.stateDir, 'primary_test/upload.lock')), { code: 'ENOENT' });
  await fs.writeFile(path.join(f.stateDir, 'primary_test/upload.lock'), 'occupied');
  await assert.rejects(runner.uploadBatch({ jobs: [f] }), /store_upload_locked/);
  assert.deepEqual(b.counts(), { filePosts: 0, registerPosts: 0 });
});

test('stepped batch yields only after requests settle and sends no POST before commit', async t => {
  const f = await fixture(t), b = fakeBrowser(f), runner = createUploader({ cdp: b.cdp, stateDir: f.stateDir });
  const steps = runner.uploadBatchSteps({ jobs: [f] });
  assert.equal((await steps.next()).value.phase, 'prepared');
  await assert.rejects(runner.uploadApproved(f), /store_upload_locked/);
  let step;
  do {
    step = await steps.next();
    assert.deepEqual(b.counts(), { filePosts: 0, registerPosts: 0 });
  } while (step.value.phase !== 'ready_to_upload');
  assert.equal((await steps.next()).value.phase, 'uploaded_pending_verification');
  assert.deepEqual(b.counts(), { filePosts: 1, registerPosts: 1 });
  assert.equal(b.calls.filter(c => c.endpoint.startsWith('https://sc04.alicdn.com')).length, 0);
  assert.equal((await steps.next()).value.result.ok, true);
  assert.equal((await steps.next()).done, true);
  await assert.rejects(fs.access(path.join(f.stateDir, 'primary_test/upload.lock')), { code: 'ENOENT' });
});

test('shared batch command failure keeps nine distinct job paths and reports reconciliation without retrying POST', async t => {
  const fixtures = await Promise.all(Array.from({ length: 9 }, (_, i) => fixture(t, 'MAIN' + (i + 1), i + 1)));
  const f = fixtures[0], b = fakeBrowser(f, { assets: fixtures });
  const send = b.cdp.send, timeout = new Error('synthetic command timeout after remote file effects');
  b.cdp.send = async (...args) => {
    const result = await send(...args);
    if (args[1].expression.includes('"op":"upload_many"')) throw timeout;
    return result;
  };
  const runner = createUploader({ cdp: b.cdp, stateDir: f.stateDir });
  const steps = runner.uploadBatchSteps({ jobs: fixtures });
  let step;
  do { step = await steps.next(); } while (step.value.phase !== 'ready_to_upload');
  const interrupted = (await steps.next()).value;
  assert.equal(interrupted.phase, 'reconcile_required');
  assert.equal(interrupted.failed, 9);
  const batchPath = path.join(f.stateDir, 'primary_test', 'batches', interrupted.batch_id + '.json');
  const persisted = JSON.parse(await fs.readFile(batchPath, 'utf8'));
  assert.equal(persisted.phase, 'reconcile_required');
  assert.equal(persisted.failed, 9);
  assert.deepEqual(b.counts(), { filePosts: 9, registerPosts: 0 });
  const result = (await steps.next()).value.result;
  assert.deepEqual(result.counts, { uploaded_new: 0, reused_existing: 0, failed: 9 });
  assert.equal(new Set(result.results.map(r => r.job_path)).size, 9);
  for (const row of result.results) {
    assert.equal(row.code, 'browser_command_failed');
    assert.equal(row.job_path, path.join(f.stateDir, 'primary_test', 'jobs', row.sha256 + '.json'));
    assert.equal(JSON.parse(await fs.readFile(row.job_path, 'utf8')).phase, 'file_post_started');
  }
  assert.equal((await steps.next()).done, true);
  await assert.rejects(runner.uploadBatch({ jobs: fixtures }), /pending_browser_jobs_reconcile_first/);
  assert.deepEqual(b.counts(), { filePosts: 9, registerPosts: 0 });
});

test('upload error cloning preserves code operation and native cause with the selected job path', async t => {
  const f = await fixture(t), b = fakeBrowser(f), nativeCause = new Error('synthetic extension interruption');
  const send = b.cdp.send;
  b.cdp.send = async (...args) => {
    if (args[1].expression.includes('"op":"upload"')) throw nativeCause;
    return send(...args);
  };
  const runner = createUploader({ cdp: b.cdp, stateDir: f.stateDir });
  await assert.rejects(runner.uploadApproved(f), error => {
    assert.equal(error.code, 'browser_command_failed');
    assert.equal(error.operation, 'upload');
    assert.equal(error.cause, nativeCause);
    assert.equal(error.jobPath, path.join(f.stateDir, 'primary_test', 'jobs', hash(f.bytes) + '.json'));
    return true;
  });
  assert.deepEqual(b.counts(), { filePosts: 0, registerPosts: 0 });
});

test('stepped browser commands belong to the current tool invocation context', async t => {
  const fixtures = await Promise.all([fixture(t, 'MAIN01', 1), fixture(t, 'MAIN02', 2)]);
  const b = fakeBrowser(fixtures[0], { assets: fixtures }), scope = new AsyncLocalStorage();
  let current = 0;
  const send = b.cdp.send;
  b.cdp.send = (...args) => {
    assert.equal(scope.getStore(), current, 'no worker from an earlier tool call may issue a browser command');
    return send(...args);
  };
  const runner = createUploader({ cdp: b.cdp, stateDir: fixtures[0].stateDir });
  for (const reuseOnly of [false, true]) {
    const steps = runner.uploadBatchSteps({ jobs: fixtures.map(j => ({ ...j, reuseOnly })) });
    let step;
    do {
      current++;
      step = await scope.run(current, () => steps.next());
      if (step.value?.phase === 'complete') assert.equal(step.value.result.ok, true);
    } while (!step.done);
  }
  assert.deepEqual(b.counts(), { filePosts: 2, registerPosts: 2 });
});

async function consumeSteps(steps, next = () => steps.next()) {
  const values = [];
  for (;;) {
    const step = await next();
    if (step.done) return values;
    values.push(step.value);
  }
}

test('one round indexes once across batches and persists each uploaded image immediately', async t => {
  const fixtures = await Promise.all([fixture(t, 'MAIN01', 1), fixture(t, 'MAIN02', 2)]), f = fixtures[0];
  const b = fakeBrowser(f, { assets: fixtures }), runner = createUploader({ cdp: b.cdp, stateDir: f.stateDir });
  const indexed = await consumeSteps(runner.beginRoundSteps({ roundId: 'one-round' }));
  assert.equal(indexed.at(-1).phase, 'index_ready');
  assert.equal((await runner.galleryStatus()).total, 0);
  await assert.rejects(fs.access(path.join(f.stateDir, 'primary_test/upload.lock')), { code: 'ENOENT' });
  for (let i = 0; i < fixtures.length; i++) {
    const stages = await consumeSteps(runner.uploadBatchSteps({ jobs: [fixtures[i]] }));
    assert.deepEqual(stages.at(-1).result.counts, { uploaded_new: 1, reused_existing: 0, failed: 0 });
    const saved = await runner.galleryStatus();
    assert.equal(saved.total, i + 1);
    assert.equal(saved.stats.full_scans, 1);
    assert.equal(saved.stats.incremental_checks, i + 1);
    assert.equal(saved.stats.fallbacks, 0);
    assert.ok(saved.items.some(item => item.photobankImageMetadata.hashCode === md5(fixtures[i].bytes)));
  }
  const resumed = createUploader({ cdp: b.cdp, stateDir: f.stateDir });
  await consumeSteps(resumed.beginRoundSteps({ roundId: 'one-round' }));
  assert.equal((await resumed.galleryStatus()).stats.full_scans, 1);
  const reused = await consumeSteps(resumed.uploadBatchSteps({ jobs: fixtures.map(j => ({ ...j, reuseOnly: true })) }));
  assert.deepEqual(reused.at(-1).result.counts, { uploaded_new: 0, reused_existing: 2, failed: 0 });
  assert.deepEqual(b.counts(), { filePosts: 2, registerPosts: 2 });
  assert.equal((await resumed.galleryStatus()).stats.full_scans, 1);
});

test('round indexes persist independently for three stores sharing a state directory', async t => {
  const f = await fixture(t), stores = Object.values(STORES);
  const browsers = stores.map((store, i) => fakeBrowser(f, { store, existing: true, imageId: 2001 + i }));
  const runners = stores.map((store, i) => createUploader({ cdp: browsers[i].cdp, shopId: store.id, stateDir: f.stateDir }));
  await Promise.all(runners.map(r => consumeSteps(r.beginRoundSteps({ roundId: 'three-store-round' }))));
  for (let i = 0; i < stores.length; i++) {
    const saved = await runners[i].galleryStatus();
    assert.equal(saved.shop_id, stores[i].id);
    assert.equal(saved.seller_admin_ali_id, stores[i].aliId);
    assert.equal(saved.items[0].id, 2001 + i);
    assert.equal(saved.items[0].groupId, stores[i].groupId);
    assert.equal(saved.stats.full_scans, 1);
    assert.deepEqual(browsers[i].counts(), { filePosts: 0, registerPosts: 0 });
  }
  browsers[0].db.push({ ...browsers[0].item(9999, 42), displayName: 'external', photobankImageMetadata: { hashCode: 'external', size: 10, width: 1, height: 1 } });
  await runners[0].inspectBatch({ jobs: [f] });
  assert.equal((await runners[0].galleryStatus()).total, 2);
  assert.equal((await runners[0].galleryStatus()).stats.incremental_checks, 1);
  for (const other of runners.slice(1)) {
    assert.equal((await other.galleryStatus()).total, 1);
    assert.equal((await other.galleryStatus()).stats.incremental_checks, 0);
  }
});

test('same-count gallery replacement falls back to a complete fresh index', async t => {
  const fixtures = await Promise.all([fixture(t, 'MAIN01', 1), fixture(t, 'MAIN02', 2)]), f = fixtures[0];
  const b = fakeBrowser(f, { assets: fixtures, existing: true });
  const runner = createUploader({ cdp: b.cdp, stateDir: f.stateDir });
  await consumeSteps(runner.beginRoundSteps({ roundId: 'replacement' }));
  b.db.splice(0, 1, b.item(1002, DADB.groupId, fixtures[1]));
  const inspection = await runner.inspectBatch({ jobs: [f] });
  assert.equal(inspection.assets[0].unuploaded, true);
  const saved = await runner.galleryStatus();
  assert.equal(saved.total, 1);
  assert.equal(saved.items[0].id, 1002);
  assert.equal(saved.stats.full_scans, 2);
  assert.equal(saved.stats.fallbacks, 1);
  assert.equal(saved.last_sync.reason, 'gallery_delta_count_mismatch');
  assert.deepEqual(b.counts(), { filePosts: 0, registerPosts: 0 });
});

test('moving a target image beyond the recent-page window triggers directory reconciliation fallback', async t => {
  const f = await fixture(t), b = fakeBrowser(f, { existing: true });
  b.db.unshift(...[2,3,4,5,6].map(id => ({ ...b.item(id, 42), displayName: 'other' + id, photobankImageMetadata: { hashCode: 'other' + id, size: 10, width: 1, height: 1 } })));
  const runner = createUploader({ cdp: b.cdp, stateDir: f.stateDir, pageSize: 5 });
  await consumeSteps(runner.beginRoundSteps({ roundId: 'moved-directory' }));
  b.db.at(-1).groupId = 42;
  await consumeSteps(runner.beginRoundSteps({ roundId: 'moved-directory' }));
  const saved = await runner.galleryStatus();
  assert.equal(saved.total, 6);
  assert.equal(saved.items.filter(x => x.groupId === DADB.groupId).length, 0);
  assert.equal(saved.stats.full_scans, 2);
  assert.equal(saved.stats.fallbacks, 1);
  assert.equal(saved.last_sync.reason, 'target_catalog_changed');
  await assert.rejects(runner.uploadApproved(f), /duplicate_outside_target/);
  assert.deepEqual(b.counts(), { filePosts: 0, registerPosts: 0 });
});

test('wrong seller during round sync stops without replacing the saved index or sending POST', async t => {
  const f = await fixture(t), options = { existing: true }, b = fakeBrowser(f, options);
  const runner = createUploader({ cdp: b.cdp, stateDir: f.stateDir });
  await consumeSteps(runner.beginRoundSteps({ roundId: 'seller-bound' }));
  const saved = await runner.galleryStatus();
  options.wrongSeller = true;
  await assert.rejects(runner.inspectBatch({ jobs: [f] }), /seller_identity_mismatch/);
  await assert.rejects(runner.uploadBatch({ jobs: [f] }), /seller_identity_mismatch/);
  assert.deepEqual(await runner.galleryStatus(), saved);
  await assert.rejects(fs.access(path.join(f.stateDir, 'primary_test/upload.lock')), { code: 'ENOENT' });
  assert.deepEqual(b.counts(), { filePosts: 0, registerPosts: 0 });
});

test('round indexing, incremental checks and upload steps use each current invocation context', async t => {
  const fixtures = await Promise.all([fixture(t, 'MAIN01', 1), fixture(t, 'MAIN02', 2)]), f = fixtures[0];
  const b = fakeBrowser(f, { assets: fixtures }), scope = new AsyncLocalStorage();
  let current = 0, commands = 0;
  const send = b.cdp.send;
  b.cdp.send = (...args) => {
    assert.equal(scope.getStore(), current, 'round operations must not retain a prior tool invocation');
    commands++;
    return send(...args);
  };
  const runner = createUploader({ cdp: b.cdp, stateDir: f.stateDir, pageSize: 1 });
  const consumeInContexts = steps => consumeSteps(steps, () => scope.run(++current, () => steps.next()));
  await consumeInContexts(runner.beginRoundSteps({ roundId: 'tool-contexts' }));
  for (const reuseOnly of [false, true]) {
    const stages = await consumeInContexts(runner.uploadBatchSteps({ jobs: fixtures.map(j => ({ ...j, reuseOnly })) }));
    assert.equal(stages.at(-1).result.ok, true);
  }
  assert.ok(commands > 10);
  assert.deepEqual(b.counts(), { filePosts: 2, registerPosts: 2 });
  assert.equal((await runner.galleryStatus()).stats.full_scans, 1);
  assert.equal((await runner.galleryStatus()).stats.incremental_checks, 2);
});

test('default strategy reuses nine verified local mappings with zero browser calls and zero new POSTs', async t => {
  const fixtures = await Promise.all(Array.from({ length: 9 }, (_, i) => fixture(t, 'MAIN' + (i + 1), i + 1))), f = fixtures[0];
  const b = fakeBrowser(f, { assets: fixtures });
  const seeded = await createUploader({ cdp: b.cdp, stateDir: f.stateDir }).uploadBatch({ jobs: fixtures });
  assert.equal(seeded.ok, true);
  b.calls.length = 0;
  const runner = createConfiguredUploader({ cdp: b.cdp, stateDir: f.stateDir });
  const inspected = await runner.inspectBatch({ jobs: fixtures });
  assert.ok(inspected.assets.every(a => a.local_mapping && !a.needs_upload));
  const reused = await runner.uploadBatch({ jobs: fixtures.map(j => ({ ...j, reuseOnly: true })) });
  assert.deepEqual(reused.counts, { uploaded_new: 0, reused_existing: 9, failed: 0 });
  assert.ok(reused.results.every(r => r.reuse_source === 'verified_local_mapping'));
  assert.equal((await runner.uploadApproved(f)).reuse_source, 'verified_local_mapping');
  assert.equal(b.calls.length, 0);
  assert.deepEqual(b.counts(), { filePosts: 9, registerPosts: 9 });
});

test('default fresh uploads only inspect identity and group before POST and read back the target directory', async t => {
  const fixtures = await Promise.all([fixture(t, 'MAIN01', 1), fixture(t, 'MAIN02', 2)]), f = fixtures[0];
  const b = fakeBrowser(f, { assets: fixtures }), runner = createConfiguredUploader({ cdp: b.cdp, stateDir: f.stateDir });
  const inspected = await runner.inspectBatch({ jobs: fixtures });
  assert.ok(inspected.assets.every(a => a.unuploaded === null && a.platform_dedupe_pending));
  assert.equal(b.calls.filter(c => c.endpoint.endsWith('/fetch/bank')).length, 0);
  const steps = runner.uploadBatchSteps({ jobs: fixtures });
  let step;
  do { step = await steps.next(); } while (step.value.phase !== 'ready_to_upload');
  assert.equal(b.calls.filter(c => c.endpoint.endsWith('/fetch/bank')).length, 0);
  const rest = await consumeSteps(steps);
  assert.deepEqual(rest.at(-1).result.counts, { uploaded_new: 2, reused_existing: 0, failed: 0 });
  const bankCalls = b.calls.filter(c => c.endpoint.endsWith('/fetch/bank'));
  assert.equal(bankCalls.length, 1, 'post-registration readback is shared by the batch');
  assert.ok(bankCalls.every(c => c.search.groupId === DADB.groupId));
  assert.deepEqual(b.counts(), { filePosts: 2, registerPosts: 2 });
});

test('default upload never refreshes or falls back to a full gallery even when a manual index exists', async t => {
  const f = await fixture(t), b = fakeBrowser(f), runner = createConfiguredUploader({ cdp: b.cdp, stateDir: f.stateDir });
  await consumeSteps(runner.beginRoundSteps({ roundId: 'manual-index' }));
  b.db.push({ ...b.item(9999, 42), displayName: 'external', photobankImageMetadata: { hashCode: 'external', size: 10, width: 1, height: 1 } });
  b.calls.length = 0;
  const result = await runner.uploadApproved(f);
  assert.equal(result.action, 'uploaded_new');
  assert.ok(b.calls.filter(c => c.endpoint.endsWith('/fetch/bank')).every(c => c.search.groupId === DADB.groupId));
  const saved = await runner.galleryStatus();
  assert.equal(saved.stats.full_scans, 1);
  assert.equal(saved.stats.incremental_checks, 0);
  assert.equal(saved.items.length, 1);
  assert.equal(saved.items[0].id, result.mapping.platform_image_id);
  const resumed = createConfiguredUploader({ cdp: b.cdp, stateDir: f.stateDir });
  b.calls.length = 0;
  assert.equal((await resumed.uploadApproved(f)).reuse_source, 'verified_local_mapping');
  assert.equal(b.calls.length, 0);
});

test('default platform duplicate response requires reconciliation without interpreting unknown ID fields', async t => {
  const f = await fixture(t), b = fakeBrowser(f, { duplicateRegistration: true });
  const runner = createConfiguredUploader({ cdp: b.cdp, stateDir: f.stateDir });
  const steps = await consumeSteps(runner.uploadBatchSteps({ jobs: [f] }));
  assert.equal(steps.find(s => s.phase === 'reconcile_required').failed, 1);
  const result = steps.at(-1).result;
  assert.equal(result.results[0].code, 'registration_duplicate_reconcile_required');
  assert.equal(result.counts.failed, 1);
  assert.deepEqual(b.counts(), { filePosts: 1, registerPosts: 1 });
  await assert.rejects(fs.access(path.join(f.stateDir, 'primary_test', 'mappings', hash(f.bytes) + '.json')), { code: 'ENOENT' });
  await assert.rejects(runner.uploadApproved(f), /registration_uncertain_no_retry/);
  assert.deepEqual(b.counts(), { filePosts: 1, registerPosts: 1 });
  assert.ok(b.calls.filter(c => c.endpoint.endsWith('/fetch/bank')).every(c => c.search.groupId === DADB.groupId));
});

test('default mapping reuse rejects source or store tampering without contacting the browser', async t => {
  const f = await fixture(t), b = fakeBrowser(f);
  const seeded = await createUploader({ cdp: b.cdp, stateDir: f.stateDir }).uploadApproved(f);
  const original = JSON.parse(await fs.readFile(seeded.mappingPath, 'utf8'));
  const runner = createConfiguredUploader({ cdp: b.cdp, stateDir: f.stateDir });
  b.calls.length = 0;
  await fs.writeFile(seeded.mappingPath, JSON.stringify({ ...original, local_md5: 'wrong' }));
  await assert.rejects(runner.uploadApproved(f), /mapping_source_mismatch/);
  await fs.writeFile(seeded.mappingPath, JSON.stringify({ ...original, shop_id: 'secondary_a' }));
  await assert.rejects(runner.uploadBatch({ jobs: [f] }), /mapping_identity_or_variant_mismatch/);
  await fs.writeFile(seeded.mappingPath, JSON.stringify(original));
  await fs.appendFile(f.local, 'changed');
  await assert.rejects(runner.uploadApproved(f), /approved_file_changed/);
  assert.equal(b.calls.length, 0);
  assert.deepEqual(b.counts(), { filePosts: 1, registerPosts: 1 });
});

test('default mixed local reuse and new upload keep per-tool contexts and do not rescan the gallery', async t => {
  const fixtures = await Promise.all([fixture(t, 'MAIN01', 1), fixture(t, 'MAIN02', 2)]), f = fixtures[0];
  const b = fakeBrowser(f, { assets: fixtures });
  await createUploader({ cdp: b.cdp, stateDir: f.stateDir }).uploadApproved(f);
  b.calls.length = 0;
  const scope = new AsyncLocalStorage(), send = b.cdp.send;
  let current = 0;
  b.cdp.send = (...args) => {
    assert.equal(scope.getStore(), current, 'default workers must use the current tool invocation');
    return send(...args);
  };
  const runner = createConfiguredUploader({ cdp: b.cdp, stateDir: f.stateDir });
  const steps = runner.uploadBatchSteps({ jobs: fixtures });
  const stages = await consumeSteps(steps, () => scope.run(++current, () => steps.next()));
  assert.deepEqual(stages.at(-1).result.counts, { uploaded_new: 1, reused_existing: 1, failed: 0 });
  assert.equal(stages.at(-1).result.results[0].reuse_source, 'verified_local_mapping');
  const bankCalls = b.calls.filter(c => c.endpoint.endsWith('/fetch/bank'));
  assert.equal(bankCalls.length, 1);
  assert.ok(bankCalls.every(c => c.search.groupId === DADB.groupId));
  assert.deepEqual(b.counts(), { filePosts: 2, registerPosts: 2 });
});

test('default readback restores a missing verified mapping by target lookup without repeating POST', async t => {
  const f = await fixture(t), b = fakeBrowser(f);
  const original = await createUploader({ cdp: b.cdp, stateDir: f.stateDir }).uploadApproved(f);
  await fs.unlink(original.mappingPath);
  b.calls.length = 0;
  const restored = await createConfiguredUploader({ cdp: b.cdp, stateDir: f.stateDir }).uploadApproved(f);
  assert.equal(restored.action, 'reused_existing');
  assert.equal(restored.mapping.platform_image_id, original.mapping.platform_image_id);
  assert.deepEqual(b.counts(), { filePosts: 1, registerPosts: 1 });
  assert.ok(b.calls.filter(c => c.endpoint.endsWith('/fetch/bank')).every(c => c.search.groupId === DADB.groupId));
});

test('default strategy rejects forbidden D models in new and old stores before lookup or upload', async t => {
  const f = await fixture(t), entries = JSON.parse(await fs.readFile(f.indexPath, 'utf8'));
  entries[0].model = 'D-SYNTHETIC';
  await fs.writeFile(f.indexPath, JSON.stringify(entries));
  for (const shopId of ['secondary_a', 'secondary_b']) {
    const b = fakeBrowser(f, { store: STORES[shopId] }), runner = createConfiguredUploader({ cdp: b.cdp, stateDir: f.stateDir, shopId });
    await assert.rejects(runner.uploadApproved(f), /d_model_forbidden/);
    await assert.rejects(runner.uploadBatch({ jobs: [f] }), /d_model_forbidden/);
    assert.equal(b.calls.length, 0);
  }
});

async function detailFixture(t, { automatic = true, extension = '.jpg', model = 'SYNTH-N', png = false } = {}) {
  const f = await fixture(t, 'DETAIL01');
  const oldLocal = f.local;
  f.local = path.join(f.root, 'SYNTH-N_EN_DETAIL01' + extension);
  f.relativePath = 'SYNTH-N/EN_DETAIL01' + extension;
  if (!png) {
    f.bytes = Buffer.alloc(120000, 7);
    // SOI, a baseline SOF with three components, then an EOI sentinel.
    Buffer.from([0xff,0xd8,0xff,0xc0,0x00,0x11,0x08,0x04,0xe6,0x04,0xe6,0x03,0x01,0x11,0,0x02,0x11,0,0x03,0x11,0]).copy(f.bytes);
    f.bytes.writeUInt16BE(0xffd9, f.bytes.length - 2);
  }
  await fs.writeFile(f.local, f.bytes);
  await fs.unlink(oldLocal);
  const entry = { model, variant: '标准款', template: 'EN_DETAIL', slot: 'DETAIL01', asset_role: 'detail',
    detail_order: 1, automatic_listing_allowed: automatic, source_language: 'en', source_path: f.local, source_folder: f.root,
    relative_path: f.relativePath, local_path: f.local, sha256: hash(f.bytes), bytes: f.bytes.length, width: 1254, height: 1254,
    user_approval: 'upload_authorized', approval_evidence: f.approval };
  const evidence = { status: 'user_upload_authorized', scope: 'wecom_english_product_details', authorization_text: 'Upload this selected batch of original English detail images.',
    files: [{ path: f.relativePath, sha256: entry.sha256, model, variant: entry.variant, source_path: f.local, source_language: 'en', automatic_listing_allowed: automatic }] };
  const save = async () => {
    const content = Buffer.from(JSON.stringify(evidence));
    await fs.writeFile(f.approval, content);
    entry.approval_evidence_sha256 = hash(content);
    await fs.writeFile(f.indexPath, JSON.stringify([entry]));
  };
  await save();
  return { ...f, entry, evidence, save };
}

test('authorized original JPEG details retain MIME, source provenance, listing policy and cached reuse', async t => {
  const f = await detailFixture(t), b = fakeBrowser(f);
  const runner = createConfiguredUploader({ cdp: b.cdp, stateDir: f.stateDir });
  const result = await runner.uploadApproved(f);
  assert.equal(result.mapping.user_approval, 'upload_authorized');
  assert.equal(result.mapping.asset_role, 'detail');
  assert.equal(result.mapping.source_path, f.local);
  assert.equal(result.mapping.automatic_listing_allowed, true);
  assert.equal(result.mapping.platform_filename, 'ATEST.jpg');
  const reference = await resolveImage({ sha256: hash(f.bytes), model: f.entry.model, variant: f.entry.variant, stateDir: f.stateDir });
  assert.equal(reference.detail_order, 1);
  assert.equal(reference.automatic_listing_allowed, true);
  assert.equal((await runner.uploadApproved(f)).action, 'reused_existing');
  assert.deepEqual(b.counts(), { filePosts: 1, registerPosts: 1 });
});

test('manual-only details upload and reuse, while automatic listing resolution fails closed', async t => {
  const f = await detailFixture(t, { automatic: false }), b = fakeBrowser(f), runner = createConfiguredUploader({ cdp: b.cdp, stateDir: f.stateDir });
  await runner.uploadApproved(f);
  await assert.rejects(resolveImage({ sha256: hash(f.bytes), model: f.entry.model, variant: f.entry.variant, stateDir: f.stateDir }), /automatic_listing_not_allowed/);
  assert.equal((await runner.uploadApproved(f)).action, 'reused_existing');
  f.entry.automatic_listing_allowed = true;
  await f.save();
  await assert.rejects(prepareAsset(f), /file_not_in_upload_authorization_scope/);
});

test('details require a separate exact-file upload authorization and English source metadata', async t => {
  const f = await detailFixture(t);
  f.evidence.status = 'user_approved'; await f.save();
  await assert.rejects(prepareAsset(f), /file_not_in_upload_authorization_scope/);
  f.evidence.status = 'user_upload_authorized'; f.evidence.files[0].variant = 'other'; await f.save();
  await assert.rejects(prepareAsset(f), /file_not_in_upload_authorization_scope/);
  f.evidence.files[0].variant = f.entry.variant; f.entry.source_language = 'zh'; await f.save();
  await assert.rejects(prepareAsset(f), /detail_source_and_order_required/);
  f.entry.source_language = 'en'; f.entry.detail_order = 2; await f.save();
  await assert.rejects(prepareAsset(f), /detail_source_and_order_required/);
});

test('JPEG details reject extension spoofing, truncated segment headers and mismatched dimensions', async t => {
  const spoofed = await detailFixture(t, { extension: '.png' });
  await assert.rejects(prepareAsset(spoofed), /jpeg_filename_required/);
  const truncated = await detailFixture(t);
  truncated.bytes.writeUInt16BE(0xffff, 4); truncated.bytes = truncated.bytes.subarray(0, 30);
  truncated.bytes.writeUInt16BE(0xffd9, truncated.bytes.length - 2);
  truncated.entry.bytes = truncated.bytes.length; truncated.entry.sha256 = hash(truncated.bytes);
  truncated.evidence.files[0].sha256 = truncated.entry.sha256;
  await fs.writeFile(truncated.local, truncated.bytes); await truncated.save();
  await assert.rejects(prepareAsset(truncated), /invalid_jpeg_segment/);
  const dimensions = await detailFixture(t); dimensions.entry.height = 1; await dimensions.save();
  await assert.rejects(prepareAsset(dimensions), /image_spec_mismatch/);
});

test('detail authorization cannot authorize JPEG main images or D models in other stores', async t => {
  const f = await detailFixture(t, { model: 'D-SYNTHETIC' });
  for (const shopId of ['secondary_a', 'secondary_b']) {
    const b = fakeBrowser(f, { store: STORES[shopId] });
    await assert.rejects(createConfiguredUploader({ cdp: b.cdp, shopId, stateDir: f.stateDir }).uploadBatch({ jobs: [f] }), /d_model_forbidden/);
    assert.equal(b.calls.length, 0);
  }
  f.entry.slot = 'MAIN01'; f.entry.user_approval = 'approved'; f.evidence.status = 'user_approved'; await f.save();
  await assert.rejects(prepareAsset(f), /png_or_detail_jpeg_required/);
});

test('JPEG receipt format mismatch stops before registration and original source changes stop before browser', async t => {
  const f = await detailFixture(t), b = fakeBrowser(f, { receiptExtension: '.png' });
  await assert.rejects(createConfiguredUploader({ cdp: b.cdp, stateDir: f.stateDir }).uploadApproved(f), /file_upload_failed_or_uncertain/);
  assert.deepEqual(b.counts(), { filePosts: 1, registerPosts: 0 });
  const copied = await detailFixture(t), original = path.join(copied.root, 'microdrive-original.jpg');
  await fs.writeFile(original, copied.bytes); copied.entry.source_path = original; copied.evidence.files[0].source_path = original; await copied.save();
  await fs.appendFile(original, 'changed');
  await assert.rejects(prepareAsset(copied), /detail_original_changed/);
});

test('original PNG details use the same separate upload authorization', async t => {
  const f = await detailFixture(t, { png: true, extension: '.png' });
  assert.equal((await prepareAsset(f)).asset.mimeType, 'image/png');
  const b = fakeBrowser(f);
  assert.equal((await createConfiguredUploader({ cdp: b.cdp, stateDir: f.stateDir }).uploadApproved(f)).mapping.asset_role, 'detail');
});

test('existing ungrouped detail adoption uses verified all-bank reads and clears only the confirmed duplicate task', async t => {
  const f = await detailFixture(t), b = fakeBrowser(f), candidate = b.item(4001, null);
  b.db.push({ ...b.item(4000), photobankImageMetadata: { ...candidate.photobankImageMetadata, hashCode: 'other' } }, candidate);
  const sha = hash(f.bytes), key = 'primary_test_' + sha;
  b.ctx.window.__codexPhotobankUploadsV1 = { [key]: { storeId: 'primary_test', sha256: sha, phase: 'register_post_started', registerCompletedAt: '2026-10-21T01:01:00Z',
    registerResult: { duplicateCount: 1, errorCode: 'DUPLICATE' } }, other: { phase: 'prepared' } };
  const p = await prepareAsset(f), jobPath = path.join(f.stateDir, 'primary_test', 'jobs', sha + '.json');
  await fs.mkdir(path.dirname(jobPath), { recursive: true });
  await fs.writeFile(jobPath, JSON.stringify({ shop_id: 'primary_test', image_hash: sha, source_index: p.sourceIndex, source_selector: f.relativePath,
    phase: 'register_post_started', duplicate_receipt: { errorCode: 'DUPLICATE' } }));
  const result = await adoptExistingDetail({ ...f, cdp: b.cdp, shopId: 'primary_test', cachedItem: candidate, pageSize: 1 });
  assert.equal(result.mapping.platform_group_id, null);
  assert.equal(result.mapping.group_name, null);
  assert.equal(result.mapping.adopted_existing_detail, true);
  assert.equal(result.cleanup.cleaned, true);
  assert.equal(b.ctx.window.__codexPhotobankUploadsV1[key], undefined);
  assert.equal(b.ctx.window.__codexPhotobankUploadsV1.other.phase, 'prepared');
  const job = JSON.parse(await fs.readFile(jobPath, 'utf8'));
  assert.equal(job.phase, 'verified'); assert.equal(job.duplicate_receipt.errorCode, 'DUPLICATE');
  const ref = await resolveImage({ sha256: sha, model: f.entry.model, variant: f.entry.variant, stateDir: f.stateDir });
  assert.equal(ref.platform_image_id, 4001);
  assert.ok(b.calls.filter(c => c.endpoint.endsWith('/fetch/bank')).every(c => String(c.search.groupId) === '-1'));
  assert.deepEqual(b.counts(), { filePosts: 0, registerPosts: 0 });
});

test('existing detail in another real folder is adopted without moving and evidence is checked on resolution', async t => {
  const f = await detailFixture(t), b = fakeBrowser(f, { extraGroups: [{ id: 42, name: 'Original English details', aliMemberId: DADB.memberSeq }] });
  const candidate = b.item(4001, 42); b.db.push(candidate);
  const result = await adoptExistingDetail({ ...f, cdp: b.cdp, shopId: 'primary_test', item: candidate });
  assert.equal(result.mapping.platform_group_id, 42);
  assert.equal(result.mapping.group_name, 'Original English details');
  assert.equal(b.db[0].groupId, 42);
  assert.deepEqual(b.counts(), { filePosts: 0, registerPosts: 0 });
  const ref = { sha256: hash(f.bytes), model: f.entry.model, variant: f.entry.variant, stateDir: f.stateDir };
  assert.equal((await resolveImage(ref)).platform_image_id, 4001);
  await fs.appendFile(result.mapping.adoption_evidence_path, ' ');
  await assert.rejects(resolveImage(ref), /detail_adoption_evidence_changed/);
});

test('adoption refuses stale candidate metadata, wrong seller, changed CDN and uncertain pending POSTs', async t => {
  for (const options of [{ wrongSeller: true }, { badCdn: true }, { uncertain: true }]) {
    const f = await detailFixture(t), b = fakeBrowser(f, options), candidate = b.item(4001, null); b.db.push(candidate);
    if (options.uncertain) b.ctx.window.__codexPhotobankUploadsV1 = { ['primary_test_' + hash(f.bytes)]: { storeId: 'primary_test', sha256: hash(f.bytes), phase: 'file_post_started' } };
    await assert.rejects(adoptExistingDetail({ ...f, cdp: b.cdp, shopId: 'primary_test', item: candidate }),
      new RegExp(options.wrongSeller ? 'seller_identity_mismatch' : options.badCdn ? 'cdn_bytes_mismatch' : 'pending_post_requires_reconciliation'));
    assert.deepEqual(b.counts(), { filePosts: 0, registerPosts: 0 });
    await assert.rejects(fs.access(path.join(f.stateDir, 'primary_test', 'mappings', hash(f.bytes) + '.json')), { code: 'ENOENT' });
  }
  const f = await detailFixture(t), b = fakeBrowser(f), candidate = b.item(4001, null);
  b.db.push({ ...candidate, photobankImageMetadata: { ...candidate.photobankImageMetadata, width: 1 } });
  await assert.rejects(adoptExistingDetail({ ...f, cdp: b.cdp, shopId: 'primary_test', item: candidate }), /existing_detail_readback_mismatch/);
});

test('adoption cannot relax main-image group rules, cross-store D limits or an active upload lock', async t => {
  const main = await fixture(t), mb = fakeBrowser(main);
  await assert.rejects(adoptExistingDetail({ ...main, cdp: mb.cdp, shopId: 'primary_test', item: mb.item() }), /detail_only_adoption/);
  const f = await detailFixture(t, { model: 'D-SYNTHETIC' }), b = fakeBrowser(f, { store: STORES.secondary_a });
  await assert.rejects(adoptExistingDetail({ ...f, cdp: b.cdp, shopId: 'secondary_a', item: b.item(4001, null) }), /d_model_forbidden/);
  const locked = await detailFixture(t), lb = fakeBrowser(locked);
  await fs.mkdir(path.join(locked.stateDir, 'primary_test'), { recursive: true });
  await fs.writeFile(path.join(locked.stateDir, 'primary_test', 'upload.lock'), '{"owner":"active-upload"}');
  await assert.rejects(adoptExistingDetail({ ...locked, cdp: lb.cdp, shopId: 'primary_test', item: lb.item(4001, null) }), /store_upload_locked/);
  assert.equal(lb.calls.length, 0);
});
