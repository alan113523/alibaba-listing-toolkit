import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { browserTask } from './browser.mjs';
import { loadStoreBindings } from './local-bindings.mjs';

export const DEFAULT_STATE_DIR = fileURLToPath(new URL('./state/', import.meta.url));
export const { DADB, STORES } = loadStoreBindings();
const uploaderBindings = new WeakMap();
const cdpQueues = new WeakMap();
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const json = async p => JSON.parse((await fs.readFile(p, 'utf8')).replace(/^\uFEFF/, ''));
const requireThat = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const isDetailEntry = entry => /^DETAIL\d+$/.test(entry.slot);
export function assertStoreModel(shopId, model) {
  requireThat(Object.hasOwn(STORES, shopId), 'unknown_store');
  requireThat(typeof model === 'string' && model.trim(), 'model_required');
  requireThat(shopId === DADB.id || !/^D/i.test(model.normalize('NFKC').trim()), 'd_model_forbidden_in_new_old_store');
}
async function browserCall(cdp, p) {
  p = { ...p, store: { ...p.store, allowDModels: p.store.id === DADB.id } };
  let r;
  try {
    const prior = cdpQueues.get(cdp) || Promise.resolve();
    const command = prior.then(() => cdp.send('Runtime.evaluate', { expression: '(' + browserTask.toString() + ')(' + JSON.stringify(p) + ')', awaitPromise: true, returnByValue: true }, { timeoutMs: p.op === 'probe' ? 180000 : 45000 }));
    cdpQueues.set(cdp, command.catch(() => {}));
    r = await command;
  }
  catch (cause) { throw Object.assign(new Error('browser_command_failed: ' + p.op, { cause }), { code: 'browser_command_failed', operation: p.op }); }
  if (r.exceptionDetails) {
    const description = r.exceptionDetails.exception?.description || r.exceptionDetails.text || '';
    const code = description.match(/(?:Error:\s*)?([a-z][a-z0-9_]{3,})/)?.[1] || 'browser_operation_failed';
    throw Object.assign(new Error(code), { code, operation: p.op });
  }
  requireThat(r.result && Object.hasOwn(r.result, 'value'), 'browser_result_missing');
  return r.result.value;
}
const optionalJson = async p => { try { return await json(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  try { await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }); }
}
async function lockStore(storeRoot) {
  await fs.mkdir(storeRoot, { recursive: true });
  const lockPath = path.join(storeRoot, 'upload.lock'), token = crypto.randomUUID();
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); }
  catch (e) { if (e.code === 'EEXIST') throw Object.assign(new Error('store_upload_locked: ' + lockPath), { code: 'store_upload_locked' }); throw e; }
  try { await lock.writeFile(JSON.stringify({ token, owner: 'codex-builtin-chrome', at: new Date().toISOString() })); }
  catch (error) { await lock.close(); await fs.unlink(lockPath); throw error; }
  return async () => {
    try { await lock.close(); } finally {
      const owner = await optionalJson(lockPath);
      if (owner?.token === token) await fs.unlink(lockPath);
    }
  };
}

export async function prepareAsset({ indexPath, relativePath }) {
  const sourceIndex = path.resolve(indexPath);
  const entries = await json(sourceIndex);
  requireThat(Array.isArray(entries), 'asset_index_must_be_array');
  const matches = entries.filter(x => x.relative_path === relativePath);
  requireThat(matches.length === 1, 'asset_selector_not_unique');
  const entry = matches[0];
  const isDetail = isDetailEntry(entry);
  requireThat(isDetail ? entry.user_approval === 'upload_authorized' && entry.asset_role === 'detail'
    : entry.user_approval === 'approved' && /^MAIN\d+$/.test(entry.slot), 'approved_main_or_authorized_detail_required');
  requireThat(typeof entry.model === 'string' && entry.model && typeof entry.variant === 'string' && entry.variant, 'model_variant_required');
  requireThat(/^[a-f0-9]{64}$/.test(entry.sha256) && path.isAbsolute(entry.local_path), 'invalid_asset_hash_or_path');
  requireThat(path.isAbsolute(entry.approval_evidence) && /^[a-f0-9]{64}$/.test(entry.approval_evidence_sha256), 'approval_evidence_required');
  const evidenceBytes = await fs.readFile(entry.approval_evidence);
  requireThat(sha256(evidenceBytes) === entry.approval_evidence_sha256, 'approval_evidence_changed');
  const evidence = JSON.parse(evidenceBytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (isDetail) {
    requireThat(entry.source_language === 'en' && typeof entry.source_path === 'string' && path.isAbsolute(entry.source_path)
      && typeof entry.source_folder === 'string' && path.isAbsolute(entry.source_folder) && typeof entry.automatic_listing_allowed === 'boolean'
      && Number.isSafeInteger(entry.detail_order) && entry.detail_order > 0 && Number(entry.slot.slice(6)) === entry.detail_order,
    'detail_source_and_order_required');
    requireThat(evidence.status === 'user_upload_authorized' && evidence.scope === 'wecom_english_product_details'
      && typeof evidence.authorization_text === 'string' && evidence.authorization_text.trim()
      && evidence.files?.some(x => x.path === entry.relative_path && x.sha256 === entry.sha256 && x.model === entry.model
        && x.variant === entry.variant && x.source_path === entry.source_path && x.source_language === 'en'
        && x.automatic_listing_allowed === entry.automatic_listing_allowed), 'file_not_in_upload_authorization_scope');
    requireThat(sha256(await fs.readFile(entry.source_path)) === entry.sha256, 'detail_original_changed');
  } else {
    requireThat(evidence.status === 'user_approved' && evidence.files?.some(x => x.path === entry.relative_path && x.sha256 === entry.sha256), 'file_not_in_approval_scope');
  }
  const bytes = await fs.readFile(entry.local_path);
  requireThat(sha256(bytes) === entry.sha256 && bytes.length === entry.bytes, 'approved_file_changed');
  const filename = path.basename(entry.local_path);
  const isPng = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii', 12, 16) === 'IHDR';
  let width, height, mimeType;
  if (isPng) {
    requireThat(/\.png$/i.test(filename), 'png_filename_required');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); mimeType = 'image/png';
  } else {
    requireThat(isDetail && bytes.length >= 4 && bytes.readUInt16BE(0) === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9, 'png_or_detail_jpeg_required');
    requireThat(/\.jpe?g$/i.test(filename), 'jpeg_filename_required');
    // JPEG dimensions are carried by a Start Of Frame segment, before scan data.
    const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    for (let offset = 2; offset < bytes.length - 2;) {
      requireThat(bytes[offset++] === 0xff, 'invalid_jpeg_segment');
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      requireThat(marker !== 0x00 && marker !== 0xd8 && marker !== 0xd9 && marker !== 0xda && offset + 2 <= bytes.length, 'jpeg_frame_required');
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = bytes.readUInt16BE(offset);
      requireThat(length >= 2 && offset + length <= bytes.length - 2, 'invalid_jpeg_segment');
      if (frameMarkers.has(marker)) {
        requireThat(length >= 8 && length === 8 + 3 * bytes[offset + 7] && bytes[offset + 7] > 0, 'invalid_jpeg_frame');
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
    requireThat(width > 0 && height > 0, 'jpeg_frame_required');
    mimeType = 'image/jpeg';
  }
  requireThat(width === entry.width && height === entry.height && width > 0 && height > 0 && bytes.length <= 5 * 1024 * 1024, 'image_spec_mismatch');
  return { entry, bytes, sourceIndex, relativePath, asset: { model: entry.model, filename, displayName: filename.replace(/\.(?:png|jpe?g)$/i, ''), mimeType, sha256: entry.sha256, md5: crypto.createHash('md5').update(bytes).digest('hex'), bytes: bytes.length, width, height } };
}

// The browser handle is obtained through the existing built-in extension inventory.
// No port discovery, external WebSocket, new browser, or login-state export.
export async function connectBuiltinChrome({ cua, browserId, tabId, stateDir = DEFAULT_STATE_DIR, ...options }) {
  const inventory = await cua.listBrowsers({ emit: false });
  const info = inventory.find(b => b.id === browserId);
  requireThat(info?.type === 'extension' && info.family === 'chrome', 'builtin_chrome_extension_required');
  const browser = await cua.getBrowser({ id: browserId });
  await browser.nameSession('🖼️ 图片银行纯接口上传');
  const tab = await cua.getTab(tabId, { browser: browserId });
  const cdp = await tab.capabilities.get('cdp');
  await cdp.documentation();
  return createUploader({ cdp, stateDir, ...options });
}

// Bind three independent extension profiles before starting any upload.
export async function connectBuiltinChromeStores({ cua, bindings, stateDir = DEFAULT_STATE_DIR, ...options }) {
  requireThat(Array.isArray(bindings) && bindings.length === 3 && new Set(bindings.map(b => b.shopId)).size === 3 && bindings.every(b => Object.hasOwn(STORES, b.shopId)), 'three_distinct_stores_required');
  const inventory = await cua.listBrowsers({ emit: false });
  const profiles = bindings.map(b => inventory.find(i => i.id === b.browserId));
  requireThat(profiles.every(p => p?.type === 'extension' && p.family === 'chrome' && p.metadata?.extensionInstanceId) && new Set(profiles.map(p => p.metadata.extensionInstanceId)).size === 3, 'three_independent_chrome_profiles_required');
  const uploaders = {};
  for (const b of bindings) uploaders[b.shopId] = await connectBuiltinChrome({ cua, stateDir, ...options, ...b });
  return {
    uploaders,
    uploadApproved: ({ jobs }) => uploadAcrossStores({ tasks: jobs.map(j => ({ ...j, uploader: uploaders[j.shopId] })) })
  };
}

export async function uploadAcrossStores({ tasks }) {
  requireThat(Array.isArray(tasks) && tasks.length === 3, 'one_task_per_store_required');
  const bindings = tasks.map(t => uploaderBindings.get(t.uploader));
  requireThat(bindings.every(Boolean) && new Set(bindings.map(b => b.store.id)).size === 3 && new Set(bindings.map(b => b.cdp)).size === 3, 'three_independent_store_uploaders_required');
  // Reject the whole selection locally before any browser work if a model is forbidden.
  for (let i = 0; i < tasks.length; i++) {
    const prepared = await prepareAsset(tasks[i]);
    assertStoreModel(bindings[i].store.id, prepared.entry.model);
    requireThat(!tasks[i].shopId || tasks[i].shopId === bindings[i].store.id, 'task_store_mismatch');
  }
  const startedAt = new Date().toISOString();
  const results = await Promise.allSettled(tasks.map(async t => {
    const started_at = new Date().toISOString();
    try {
      const result = await t.uploader.uploadApproved(t);
      return { shop_id: t.uploader.shopId, started_at, completed_at: new Date().toISOString(), ...result };
    } catch (e) {
      throw { shop_id: t.uploader.shopId, started_at, stopped_at: new Date().toISOString(), code: e.code || 'local_error', job_path: e.jobPath ?? null };
    }
  }));
  return { schema_version: 1, concurrency: { stores: 3, per_store: 1 }, started_at: startedAt, completed_at: new Date().toISOString(),
    ok: results.every(r => r.status === 'fulfilled'), results: results.map(r => r.status === 'fulfilled' ? { status: r.status, ...r.value } : { status: r.status, ...r.reason }) };
}

// Injectable only for testing or an already bound, documented extension CDP handle.
export function createUploader({ cdp, shopId = DADB.id, stateDir = DEFAULT_STATE_DIR, dedupeStrategy = 'platform', pageSize = 100, maxPages = 100, chunkChars = 65536, onProgress = async () => {} }) {
  requireThat(typeof cdp?.send === 'function', 'builtin_cdp_handle_required');
  requireThat(Object.hasOwn(STORES, shopId), 'unknown_store');
  const store = STORES[shopId];
  requireThat(['platform', 'full'].includes(dedupeStrategy), 'invalid_dedupe_strategy');
  requireThat(Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 100 && Number.isInteger(maxPages) && maxPages > 0 && maxPages <= 200, 'invalid_pagination_budget');
  requireThat(Number.isInteger(chunkChars) && chunkChars >= 4 && chunkChars <= 65536 && chunkChars % 4 === 0, 'invalid_chunk_size');
  const root = path.resolve(stateDir), storeRoot = path.join(root, store.id);
  let activeBatch, round;
  const indexPath = path.join(storeRoot, 'gallery-index.json');
  const uploader = { shopId: store.id, uploadApproved, inspectApproved, uploadBatch, uploadBatchSteps, inspectBatch, inspectPending, beginRoundSteps, galleryStatus };
  uploaderBindings.set(uploader, { cdp, store });

  async function inspectPending() {
    return browserCall(cdp, { op: 'pending', store, asset: {} });
  }

  const compact = x => Object.fromEntries(['id', 'memberSeq', 'groupId', 'displayName', 'filename', 'imageUrl', 'gmtCreate', 'photobankImageMetadata'].map(k => [k, x[k]]));
  const fingerprint = x => JSON.stringify([x.id, x.memberSeq, String(x.groupId), x.displayName, x.filename, x.imageUrl,
    x.photobankImageMetadata?.hashCode, x.photobankImageMetadata?.size, x.photobankImageMetadata?.width, x.photobankImageMetadata?.height]);
  const indexProbe = (index, target = false) => ({ total: target ? index.items.filter(x => x.groupId === store.groupId).length : index.total,
    items: index.items.filter(x => !target || x.groupId === store.groupId), before: index.identity, after: index.identity, source: 'gallery-index', round_id: index.round_id });
  async function galleryStatus() { return optionalJson(indexPath); }
  async function localMapping(prepared) {
    const mappingPath = path.join(storeRoot, 'mappings', prepared.asset.sha256 + '.json');
    const mapping = await optionalJson(mappingPath);
    if (!mapping) return null;
    await resolveImage({ sha256: prepared.asset.sha256, model: prepared.entry.model, variant: prepared.entry.variant, shopId: store.id, stateDir: root, allowManualOnly: true });
    requireThat(mapping.source_index === prepared.sourceIndex && mapping.source_selector === prepared.relativePath
      && mapping.local_path === prepared.entry.local_path && mapping.local_md5 === prepared.asset.md5
      && mapping.approval_evidence === prepared.entry.approval_evidence && mapping.approval_evidence_sha256 === prepared.entry.approval_evidence_sha256,
    'mapping_source_mismatch');
    return { action: 'reused_existing', mappingPath, mapping, reuse_source: 'verified_local_mapping' };
  }
  const mappingItem = m => ({ id: m.platform_image_id, memberSeq: m.seller_member_seq, groupId: m.platform_group_id,
    filename: m.platform_filename, displayName: path.basename(m.local_path).replace(/\.(?:png|jpe?g)$/i, ''), imageUrl: m.image_url, gmtCreate: m.saved_at,
    photobankImageMetadata: { hashCode: m.platform_response_hash, size: m.bytes, width: m.width, height: m.height } });
  const catalogPage = page => browserCall(cdp, { op: 'catalog_page', store, asset: {}, page, pageSize, maxPages });
  async function persistIndex(index) {
    requireThat(index.shop_id === store.id && index.seller_admin_ali_id === store.aliId && index.round_id === round.id
      && index.total === index.items.length && new Set(index.items.map(x => x.id)).size === index.total, 'invalid_gallery_index');
    index.updated_at = new Date().toISOString();
    await writeJson(indexPath, index);
    round.index = index;
  }
  async function* fullGallerySteps(reason) {
    const first = await catalogPage(1), pages = Math.max(1, Math.ceil(first.total / pageSize));
    const items = [...first.items], seen = new Set(items.map(x => x.id));
    yield { phase: 'indexing', shop_id: store.id, reason, page: 1, pages, total: first.total };
    for (let page = 2; page <= pages; page += 3) {
      const settled = await Promise.allSettled(Array.from({ length: Math.min(3, pages - page + 1) }, (_, i) => catalogPage(page + i)));
      const failed = settled.find(r => r.status === 'rejected');
      if (failed) throw failed.reason;
      for (const { value: result } of settled) {
        requireThat(result.total === first.total, 'pagination_total_changed');
        for (const item of result.items) { requireThat(!seen.has(item.id), 'invalid_bank_identity_or_pagination'); seen.add(item.id); items.push(item); }
      }
      yield { phase: 'indexing', shop_id: store.id, reason, page: Math.min(page + 2, pages), pages, total: first.total };
    }
    const head = await catalogPage(1);
    requireThat(head.total === first.total && JSON.stringify(head.items.map(fingerprint)) === JSON.stringify(first.items.map(fingerprint)), 'gallery_changed_during_full_scan');
    const previous = round.index;
    await persistIndex({ schema_version: 1, shop_id: store.id, seller_admin_ali_id: store.aliId, seller_member_seq: store.memberSeq,
      seller_minisite: store.minisite, round_id: round.id, complete: true, identity: head.after, full_scan_at: new Date().toISOString(),
      total: first.total, items: items.map(compact), last_sync: { mode: 'full', reason, pages: pages + 1 },
      stats: { full_scans: (previous?.stats?.full_scans || 0) + 1, incremental_checks: previous?.stats?.incremental_checks || 0,
        fallbacks: (previous?.stats?.fallbacks || 0) + (reason === 'round_start' ? 0 : 1) } });
  }
  async function* beginRoundSteps({ roundId }) {
    requireThat(typeof roundId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(roundId), 'valid_round_id_required');
    const unlock = await lockStore(storeRoot);
    try {
      const saved = await optionalJson(indexPath);
      round = { id: roundId, index: saved?.round_id === roundId ? saved : null };
      if (!round.index) yield* fullGallerySteps('round_start');
      else yield* syncGallerySteps();
      yield { phase: 'index_ready', shop_id: store.id, round_id: round.id, total: round.index.total, index_path: indexPath, stats: round.index.stats };
    } finally { await unlock(); }
  }
  async function* syncGallerySteps() {
    if (!round) return;
    let reason;
    try {
      const old = round.index;
      requireThat(old?.complete && old.total === old.items.length && old.shop_id === store.id && old.seller_admin_ali_id === store.aliId
        && old.seller_member_seq === store.memberSeq && old.seller_minisite === store.minisite && old.round_id === round.id
        && new Set(old.items.map(x => x.id)).size === old.total, 'invalid_gallery_index');
      const known = new Map(old.items.map(x => [x.id, x])), head = [], seen = new Set();
      let total, anchors = 0, pagesRead = 0;
      for (let page = 1; page <= Math.min(3, Math.max(1, Math.ceil(old.total / pageSize)) + 1); page++) {
        const response = await catalogPage(page); pagesRead++;
        if (total === undefined) total = response.total;
        requireThat(total === response.total && total >= old.total, 'gallery_total_changed');
        for (const item of response.items) {
          requireThat(!seen.has(item.id), 'invalid_bank_identity_or_pagination'); seen.add(item.id); head.push(compact(item));
          if (known.has(item.id)) { requireThat(fingerprint(known.get(item.id)) === fingerprint(item), 'known_gallery_record_changed'); anchors++; }
        }
        if (anchors >= Math.min(5, old.total) || head.length === total) break;
      }
      requireThat(anchors >= Math.min(5, old.total) || head.length === total, 'gallery_anchor_missing');
      const added = head.filter(x => !known.has(x.id));
      requireThat(total - old.total === added.length, 'gallery_delta_count_mismatch');
      const merged = [...head, ...old.items.filter(x => !seen.has(x.id))];
      const target = await browserCall(cdp, { op: 'probe', store, asset: {}, full: true, pageSize, maxPages });
      const cachedTarget = merged.filter(x => x.groupId === store.groupId), targetMap = new Map(target.items.map(x => [x.id, x]));
      requireThat(cachedTarget.length === target.total && cachedTarget.every(x => targetMap.has(x.id) && fingerprint(x) === fingerprint(targetMap.get(x.id))), 'target_catalog_changed');
      await persistIndex({ ...old, total, items: merged, identity: target.after, last_sync: { mode: 'incremental', pages: pagesRead, added: added.length },
        stats: { ...old.stats, incremental_checks: old.stats.incremental_checks + 1 } });
      return;
    } catch (e) {
      if (['seller_identity_mismatch', 'identity_http_error', 'target_group_mismatch', 'browser_command_failed'].includes(e.code)) throw e;
      reason = e.code || 'gallery_sync_failed';
    }
    yield* fullGallerySteps(reason);
  }
  let indexWrites = Promise.resolve();
  async function updateIndexItem(item) {
    const update = indexWrites.then(async () => {
      const old = round?.index ?? await optionalJson(indexPath);
      if (!old) return;
      requireThat(old.complete && old.shop_id === store.id && old.seller_admin_ali_id === store.aliId
        && old.seller_member_seq === store.memberSeq && old.seller_minisite === store.minisite
        && old.total === old.items.length && new Set(old.items.map(x => x.id)).size === old.total, 'invalid_gallery_index');
      const exists = old.items.some(x => x.id === item.id);
      const updated = { ...old, total: old.total + (exists ? 0 : 1), updated_at: new Date().toISOString(),
        items: exists ? old.items.map(x => x.id === item.id ? compact(item) : x) : [compact(item), ...old.items] };
      if (round) await persistIndex(updated);
      else await writeJson(indexPath, updated);
    });
    indexWrites = update.catch(() => {});
    await update;
  }

  async function prepareBatch(jobs) {
    requireThat(Array.isArray(jobs) && jobs.length >= 1 && jobs.length <= 9, 'batch_size_must_be_1_to_9');
    const prepared = [];
    for (const j of jobs) {
      requireThat(!j.shopId || j.shopId === store.id, 'task_store_mismatch');
      const p = await prepareAsset(j);
      assertStoreModel(store.id, p.entry.model);
      prepared.push(p);
    }
    requireThat(new Set(prepared.map(p => p.asset.sha256)).size === jobs.length, 'duplicate_asset_in_batch');
    requireThat(new Set(prepared.map(p => p.asset.displayName)).size === jobs.length, 'duplicate_filename_in_batch');
    return prepared;
  }

  async function probeBatch(prepared) {
    if (dedupeStrategy === 'platform') {
      const cached = await Promise.all(prepared.map(p => localMapping(p)));
      const identity = cached.every(Boolean) ? null : await browserCall(cdp, { op: 'preflight', store, asset: {} });
      const items = cached.filter(Boolean).map(r => mappingItem(r.mapping));
      const target = { ...identity, total: null, items, source: 'verified_local_mappings' };
      return { shop_id: store.id, strategy: dedupeStrategy, target, wholeStore: target, assets: prepared.map((p, i) => ({ ...p.asset,
        relative_path: p.relativePath, local_mapping: Boolean(cached[i]), unuploaded: cached[i] ? false : null,
        needs_upload: !cached[i], platform_dedupe_pending: !cached[i], nameConflict: false })) };
    }
    if (round) {
      const target = indexProbe(round.index, true), wholeStore = indexProbe(round.index);
      return { shop_id: store.id, target, wholeStore, assets: prepared.map(p => ({ ...p.asset, relative_path: p.relativePath,
        unuploaded: !wholeStore.items.some(x => x.photobankImageMetadata?.hashCode === p.asset.md5),
        nameConflict: target.items.some(x => x.displayName === p.asset.displayName && x.photobankImageMetadata?.hashCode !== p.asset.md5) })) };
    }
    const p = { op: 'probe', store, asset: prepared[0].asset, assets: prepared.map(p => p.asset), pageSize, maxPages };
    const target = await browserCall(cdp, p);
    const wholeStore = await browserCall(cdp, { ...p, global: true });
    return { shop_id: store.id, target, wholeStore, assets: prepared.map(p => ({ ...p.asset,
      relative_path: p.relativePath,
      unuploaded: !wholeStore.items.some(x => x.photobankImageMetadata?.hashCode === p.asset.md5),
      nameConflict: target.items.some(x => x.displayName === p.asset.displayName && x.photobankImageMetadata?.hashCode !== p.asset.md5) })) };
  }

  async function inspectBatch({ jobs }) {
    const prepared = await prepareBatch(jobs);
    if (!round || dedupeStrategy === 'platform') return probeBatch(prepared);
    const unlock = await lockStore(storeRoot);
    try { for await (const step of syncGallerySteps()) await onProgress(step); return await probeBatch(prepared); }
    finally { await unlock(); }
  }

  async function uploadBatch({ jobs }) {
    let result;
    for await (const step of uploadBatchSteps({ jobs })) if (step.phase === 'complete') result = step.result;
    return result;
  }

  async function* uploadBatchSteps({ jobs }) {
    const prepared = await prepareBatch(jobs);
    const unlock = await lockStore(storeRoot);
    const batchId = crypto.randomUUID(), batchPath = path.join(storeRoot, 'batches', batchId + '.json');
    const intent = { schema_version: 1, batch_id: batchId, shop_id: store.id, started_at: new Date().toISOString(),
      concurrency: jobs.length, transport: 'builtin-chrome-extension', chunk_chars: chunkChars, round_id: round?.id ?? null,
      jobs: prepared.map(p => ({ source_index: p.sourceIndex, relative_path: p.relativePath, sha256: p.asset.sha256 })) };
    let context;
    try {
      await writeJson(batchPath, { ...intent, phase: 'preflight' });
      if (dedupeStrategy === 'platform') {
        const cached = await Promise.all(prepared.map(p => localMapping(p)));
        if (cached.every(Boolean)) {
          const results = cached.map((result, i) => ({ relative_path: jobs[i].relativePath, sha256: prepared[i].asset.sha256,
            ...(jobs[i].requireNew ? { status: 'rejected', code: 'already_uploaded', job_path: path.join(storeRoot, 'jobs', prepared[i].asset.sha256 + '.json') }
              : { status: 'fulfilled', ...result }) }));
          const failed = results.filter(r => r.status === 'rejected').length;
          const result = { ...intent, completed_at: new Date().toISOString(), ok: failed === 0,
            counts: { uploaded_new: 0, reused_existing: jobs.length - failed, failed }, results, batchPath };
          await writeJson(batchPath, { ...result, phase: result.ok ? 'complete' : 'partial' });
          yield { phase: 'complete', result };
          return;
        }
      }
      const pending = await inspectPending();
      requireThat(!pending.length, 'pending_browser_jobs_reconcile_first');
      if (dedupeStrategy === 'full') yield* syncGallerySteps();
      const preflight = await probeBatch(prepared);
      await writeJson(batchPath, { ...intent, phase: 'running', preflight });
      let release;
      const ready = new Promise(r => { release = r; }), arrived = new Set();
      const arrive = key => { arrived.add(key); if (arrived.size === jobs.length) release(); };
      context = { id: batchId, size: jobs.length, preflight, transferred: new Set(), deferReadback: true,
        wait: async key => { arrive(key); await ready; } };
      activeBatch = context;
      const staging = prepared.filter((p, i) => !jobs[i].reuseOnly && !preflight.target.items.some(x => x.photobankImageMetadata?.hashCode === p.asset.md5)
        && !preflight.wholeStore.items.some(x => x.photobankImageMetadata?.hashCode === p.asset.md5)
        && !preflight.assets.find(a => a.sha256 === p.asset.sha256).nameConflict);
      const members = staging.map(p => ({ key: store.id + '_' + p.asset.sha256, asset: p.asset, batchId, batchSize: jobs.length }));
      const groupOperation = (op, groupMembers = members) => {
        const requested = new Map(), withdrawn = new Set();
        let dispatched = false;
        const dispatch = async () => {
          if (dispatched || requested.size + withdrawn.size !== groupMembers.length) return;
          dispatched = true;
          if (!requested.size) return;
          const selected = groupMembers.filter(m => requested.has(m.key)).map(m => ({ ...m, ...requested.get(m.key).extra }));
          try {
            const results = await browserCall(cdp, { op, store, asset: selected[0].asset, jobs: selected });
            for (const member of selected) {
              const result = results.find(r => r.key === member.key);
              if (result?.status === 'fulfilled') requested.get(member.key).resolve(result.value);
              else requested.get(member.key).reject(Object.assign(new Error(result?.code || 'batch_operation_failed'), { code: result?.code || 'batch_operation_failed' }));
            }
          } catch (error) { for (const pending of requested.values()) pending.reject(error); }
        };
        return {
          request: (key, extra = {}) => new Promise((resolve, reject) => { requested.set(key, { resolve, reject, extra }); void dispatch(); }),
          withdraw: key => { if (groupMembers.some(m => m.key === key) && !requested.has(key)) withdrawn.add(key); void dispatch(); }
        };
      };
      context.uploadGroup = groupOperation('upload_many');
      context.registerGroup = groupOperation('register_many');
      context.verifyGroup = groupOperation('verify_many', prepared.map(p => ({ key: store.id + '_' + p.asset.sha256, asset: p.asset })));
      let readback;
      context.readback = () => readback ||= browserCall(cdp, { op: dedupeStrategy === 'platform' ? 'lookup' : 'probe', store,
        assets: prepared.filter((p, i) => !preflight.assets[i].local_mapping).map(p => p.asset), full: Boolean(round), pageSize, maxPages });
      for (const p of staging) {
        const prior = await optionalJson(path.join(storeRoot, 'jobs', p.asset.sha256 + '.json'));
        requireThat(!prior || prior.phase === 'prepared', 'batch_job_reconcile_first');
      }
      const stagedCalls = await Promise.allSettled(staging.map(p => browserCall(cdp, { op: 'init', key: store.id + '_' + p.asset.sha256, store, asset: p.asset, batchId, batchSize: jobs.length })));
      requireThat(stagedCalls.every(r => r.status === 'fulfilled'), 'batch_staging_failed');
      const encoded = staging.map(p => p.bytes.toString('base64'));
      const totalRounds = Math.max(0, ...encoded.map(s => Math.ceil(s.length / chunkChars)));
      await writeJson(batchPath, { ...intent, phase: 'transferring', preflight, transfer_round: 0, transfer_rounds: totalRounds });
      yield { phase: 'prepared', batch_id: batchId, images: staging.length, transfer_round: 0, transfer_rounds: totalRounds };
      for (let first = 0; first < totalRounds; first += 3) {
        const results = await Promise.allSettled(staging.map(async (p, i) => {
          for (let index = first; index < Math.min(first + 3, Math.ceil(encoded[i].length / chunkChars)); index++) {
            const chunk = encoded[i].slice(index * chunkChars, (index + 1) * chunkChars);
            const ack = await browserCall(cdp, { op: 'chunk', key: store.id + '_' + p.asset.sha256, store, asset: p.asset, index, chunk });
            requireThat(ack.index === index && ack.length === chunk.length, 'chunk_ack_mismatch');
          }
        }));
        requireThat(results.every(r => r.status === 'fulfilled'), 'batch_transfer_failed');
        const completed = Math.min(first + 3, totalRounds);
        await writeJson(batchPath, { ...intent, phase: 'transferring', preflight, transfer_round: completed, transfer_rounds: totalRounds });
        yield { phase: 'transferring', batch_id: batchId, transfer_round: completed, transfer_rounds: totalRounds };
      }
      for (const p of staging) context.transferred.add(store.id + '_' + p.asset.sha256);
      await writeJson(batchPath, { ...intent, phase: 'ready_to_upload', preflight });
      yield { phase: 'ready_to_upload', batch_id: batchId, images: staging.length };
      const committed = await Promise.allSettled(jobs.map(async (j, i) => {
        const key = store.id + '_' + prepared[i].asset.sha256;
        try { return await uploadApproved(j, context); }
        finally { arrive(key); context.uploadGroup.withdraw(key); context.registerGroup.withdraw(key); }
      }));
      const failedCommits = committed.filter(r => r.status === 'rejected').length;
      const committedPhase = failedCommits ? 'reconcile_required' : 'uploaded_pending_verification';
      await writeJson(batchPath, { ...intent, phase: committedPhase, ...(failedCommits ? { failed: failedCommits } : {}), preflight });
      yield { phase: committedPhase, batch_id: batchId, ...(failedCommits ? { failed: failedCommits } : {}) };
      context.deferReadback = false;
      context.finalActions = new Map(committed.map((r, i) => [store.id + '_' + prepared[i].asset.sha256,
        r.status === 'fulfilled' && r.value.pendingReadback ? 'uploaded_new' : 'reused_existing']));
      if (committed.some(r => r.status === 'fulfilled' && r.value.pendingReadback)) context.preflight.target = await context.readback();
      const settled = await Promise.allSettled(jobs.map(async (j, i) => {
        const key = store.id + '_' + prepared[i].asset.sha256;
        try {
          if (committed[i].status === 'rejected') throw committed[i].reason;
          return await uploadApproved({ ...j, requireNew: false, reuseOnly: true }, context);
        } finally { context.verifyGroup.withdraw(key); }
      }));
      const results = settled.map((r, i) => ({ relative_path: jobs[i].relativePath, sha256: prepared[i].asset.sha256,
        ...(r.status === 'fulfilled' ? { status: r.status, ...r.value } : { status: r.status, code: r.reason.code || 'local_error', job_path: r.reason.jobPath ?? null }) }));
      const result = { ...intent, completed_at: new Date().toISOString(), ok: results.every(r => r.status === 'fulfilled'),
        counts: { uploaded_new: results.filter(r => r.action === 'uploaded_new').length, reused_existing: results.filter(r => r.action === 'reused_existing').length, failed: results.filter(r => r.status === 'rejected').length }, results, batchPath };
      await writeJson(batchPath, { ...result, phase: result.ok ? 'complete' : 'partial', preflight });
      yield { phase: 'complete', result };
    } catch (e) {
      await writeJson(batchPath, { ...intent, phase: 'stopped', stopped_at: new Date().toISOString(), code: e.code || 'local_error' });
      throw e;
    } finally {
      if (activeBatch === context) activeBatch = undefined;
      await unlock();
    }
  }

  async function inspectApproved({ indexPath, relativePath }) {
    if (round || dedupeStrategy === 'platform') {
      const result = await inspectBatch({ jobs: [{ indexPath, relativePath }] });
      return { ...result, asset: result.assets[0], unuploaded: result.assets[0].unuploaded, nameConflict: result.assets[0].nameConflict };
    }
    const prepared = await prepareAsset({ indexPath, relativePath });
    assertStoreModel(store.id, prepared.entry.model);
    const p = { op: 'probe', key: store.id + '_' + prepared.asset.sha256, store, asset: prepared.asset, pageSize, maxPages };
    const target = await browserCall(cdp, p);
    const wholeStore = await browserCall(cdp, { ...p, global: true });
    return { shop_id: store.id, asset: prepared.asset, target, wholeStore,
      unuploaded: !wholeStore.items.some(x => x.photobankImageMetadata?.hashCode === prepared.asset.md5),
      nameConflict: target.items.some(x => x.displayName === prepared.asset.displayName && x.photobankImageMetadata?.hashCode !== prepared.asset.md5) };
  }

  async function uploadApproved({ indexPath, relativePath, reuseOnly = false, requireNew = false }, context) {
    const prepared = await prepareAsset({ indexPath, relativePath });
    const { asset, entry } = prepared;
    assertStoreModel(store.id, entry.model);
    const key = store.id + '_' + asset.sha256;
    requireThat(!context || context === activeBatch, 'invalid_batch_context');
    if (dedupeStrategy === 'platform') {
      const cached = await localMapping(prepared);
      if (cached) { requireThat(!requireNew, 'already_uploaded'); return cached; }
    }
    const unlock = context ? async () => {} : await lockStore(storeRoot);
    const runId = crypto.randomUUID(), runDir = path.join(storeRoot, 'runs', runId);
    const jobPath = path.join(storeRoot, 'jobs', asset.sha256 + '.json');
    const mappingPath = path.join(storeRoot, 'mappings', asset.sha256 + '.json');
    let job, probeBefore;
    const event = async (phase, detail = {}) => {
      await fs.mkdir(runDir, { recursive: true });
      await fs.appendFile(path.join(runDir, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), phase, ...detail }) + '\n');
      await onProgress({ shopId: store.id, batchId: context?.id ?? null, phase, runId, filename: asset.filename, ...detail });
    };
    const checkpoint = async (phase, extra = {}) => {
      job = { ...job, schema_version: 1, batch_id: context?.id ?? null, shop_id: store.id, image_hash: asset.sha256, local_md5: asset.md5, source_index: prepared.sourceIndex, source_selector: relativePath, phase, updated_at: new Date().toISOString(), ...extra };
      await writeJson(jobPath, job);
      await event(phase);
    };
    const call = async (op, extra = {}) => {
      if (context && op === 'upload') return context.uploadGroup.request(key);
      if (context && op === 'register') return context.registerGroup.request(key);
      if (context && op === 'verify') return context.verifyGroup.request(key, extra);
      return browserCall(cdp, { op, key, store, asset, pageSize, maxPages, batchId: context?.id, batchSize: context?.size, ...extra });
    };
    const choose = probe => {
      const hashes = probe.items.filter(x => x.photobankImageMetadata?.hashCode === asset.md5);
      requireThat(hashes.length <= 1, 'multiple_platform_duplicates');
      requireThat(!probe.items.some(x => x.displayName === asset.displayName && x.photobankImageMetadata?.hashCode !== asset.md5), 'platform_name_conflict');
      return hashes[0];
    };
    const finish = async (item, action) => {
      if (context?.deferReadback) return { pendingVerification: { item, action } };
      const verified = await call('verify', { item });
      requireThat(sha256(await fs.readFile(entry.local_path)) === asset.sha256, 'source_changed_during_upload');
      const mapping = {
        schema_version: 1, status: 'verified', action, transport: 'builtin-chrome-extension', shop_id: store.id,
        seller_admin_ali_id: store.aliId, seller_member_seq: store.memberSeq, seller_minisite: store.minisite,
        group_name: store.groupName, platform_group_id: store.groupId,
        model: entry.model, variant: entry.variant, template: entry.template, slot: entry.slot,
        material_id: entry.material_id ?? null, material_version: entry.material_version ?? null,
        source_index: prepared.sourceIndex, source_selector: relativePath, local_path: entry.local_path,
        user_approval: entry.user_approval, approval_evidence: entry.approval_evidence, approval_evidence_sha256: entry.approval_evidence_sha256,
        ...(isDetailEntry(entry) ? { asset_role: 'detail', source_language: entry.source_language, source_path: entry.source_path,
          source_folder: entry.source_folder, detail_order: entry.detail_order, automatic_listing_allowed: entry.automatic_listing_allowed } : {}),
        image_hash: asset.sha256, image_hash_algorithm: 'SHA-256', local_md5: asset.md5,
        platform_image_id: item.id, image_url: verified.cdn.url, platform_filename: item.filename,
        platform_response_hash: item.photobankImageMetadata.hashCode, platform_response_hash_algorithm: 'MD5_verified',
        platform_image_hash: verified.cdn.sha256, platform_image_hash_algorithm: 'SHA-256',
        width: asset.width, height: asset.height, bytes: asset.bytes,
        verified_at: verified.verifiedAt, saved_at: item.gmtCreate ?? null,
        ready_for_listing_image_reference: true, product_id: null, product_assignment_verified: false,
        ui_actions: { click: 0, fileChooser: 0, navigate: 0, reload: 0 },
        run_id: runId, batch_id: context?.id ?? null, evidence_directory: runDir
      };
      await writeJson(path.join(runDir, 'readback.json'), verified);
      await writeJson(mappingPath, mapping);
      await checkpoint('verified', { platform_image_id: item.id, mapping_path: mappingPath });
      await updateIndexItem(item);
      await call('cleanup');
      await event('complete', { action, platform_image_id: item.id });
      return { action, mappingPath, mapping };
    };
    try {
      job = await optionalJson(jobPath);
      await event('started', { reuseOnly, requireNew });
      if (round && !context && dedupeStrategy === 'full') for await (const step of syncGallerySteps()) await onProgress(step);
      probeBefore = context?.preflight.target ?? (dedupeStrategy === 'platform'
        ? { ...await call('preflight'), total: null, items: [] } : round ? indexProbe(round.index, true) : await call('probe'));
      if (dedupeStrategy === 'platform' && (reuseOnly || ['register_post_started', 'registered', 'verified'].includes(job?.phase))
        && !probeBefore.items.some(x => x.photobankImageMetadata?.hashCode === asset.md5)) probeBefore = await call('lookup');
      await writeJson(path.join(runDir, 'dedupe-target.json'), probeBefore);
      const duplicate = choose(probeBefore);
      if (duplicate) {
        requireThat(!requireNew, 'already_uploaded');
        return await finish(duplicate, context?.finalActions?.get(key) || 'reused_existing');
      }
      if (reuseOnly) throw Object.assign(new Error('not_uploaded'), { code: 'not_uploaded' });
      requireThat(job?.phase !== 'verified', 'previous_mapping_missing_on_platform');
      const global = context?.preflight.wholeStore ?? (dedupeStrategy === 'platform' ? { total: null, items: [], source: 'platform_dedupe' }
        : round ? indexProbe(round.index) : await call('probe', { global: true }));
      const elsewhere = global.items.filter(x => x.photobankImageMetadata?.hashCode === asset.md5);
      await writeJson(path.join(runDir, 'dedupe-store.json'), global);
      requireThat(!elsewhere.length, 'duplicate_outside_target_or_concurrent_change');
      requireThat(!['register_post_started', 'registered'].includes(job?.phase), 'registration_uncertain_no_retry');
      let browserState = await call('status');
      let receipt = job?.upload;
      if (job?.phase === 'file_post_started') {
        requireThat(browserState?.phase === 'file_uploaded' && browserState.upload, 'file_post_uncertain_no_retry');
        receipt = browserState.upload;
      } else if (job?.phase !== 'file_uploaded') {
        requireThat(!browserState || browserState.phase === 'prepared', 'browser_reconcile_required');
      }
      if (!receipt) {
        await checkpoint('prepared', { initial_target_count: probeBefore.total });
        const encoded = prepared.bytes.toString('base64');
        let index = 0;
        if (!context?.transferred.has(key)) {
          await call('init');
          for (let start = 0; start < encoded.length; start += chunkChars) {
            const chunk = encoded.slice(start, start + chunkChars);
            const result = await call('chunk', { index, chunk });
            requireThat(result.index === index && result.length === chunk.length, 'chunk_ack_mismatch');
            index++;
          }
        } else {
          index = Math.ceil(encoded.length / chunkChars);
        }
        await event('transferred', { chunks: index, chunkChars });
        if (context) await context.wait(key);
        await checkpoint('file_post_started'); // Durable intent before any POST.
        browserState = await call('upload');
        requireThat(browserState.phase === 'file_uploaded', 'file_upload_unconfirmed');
        receipt = browserState.upload;
      }
      await checkpoint('file_uploaded', { upload: receipt });
      browserState = await call('status');
      if (!browserState) browserState = await call('restore', { upload: receipt });
      requireThat(browserState.phase === 'file_uploaded' && !browserState.registerAttempted, 'registration_uncertain_no_retry');
      await checkpoint('register_post_started');
      const registered = await call('register');
      requireThat(registered.phase === 'registered', 'registration_unconfirmed');
      await writeJson(path.join(runDir, 'post-receipts.json'), { upload: receipt, registration: registered.registerResult,
        timing: { upload_started_at: registered.uploadStartedAt ?? null, upload_completed_at: registered.uploadCompletedAt ?? null,
          register_started_at: registered.registerStartedAt, register_completed_at: registered.registerCompletedAt } });
      await checkpoint('registered');
      if (context?.deferReadback) return { pendingReadback: true };
      for (let attempt = 0; attempt < 3; attempt++) {
        const probe = context && attempt === 0 ? await context.readback() : await call(dedupeStrategy === 'platform' ? 'lookup' : 'probe');
        const item = choose(probe);
        if (item) return await finish(item, 'uploaded_new');
      }
      throw Object.assign(new Error('registered_pending_readback'), { code: 'registered_pending_readback' });
    } catch (e) {
      await event('stopped', { code: e.code || 'local_error', phase: job?.phase ?? 'preflight' });
      throw Object.assign(new Error(e.message, { cause: e.cause }), e, { jobPath });
    } finally {
      await unlock();
    }
  }
  return uploader;
}

// Consumer for a later listing flow. Resolves a frozen image reference, never publishes.
export async function resolveImage({ sha256: hash, model, variant, shopId = DADB.id, stateDir = DEFAULT_STATE_DIR, allowManualOnly = false }) {
  requireThat(Object.hasOwn(STORES, shopId) && /^[a-f0-9]{64}$/.test(hash), 'store_and_sha256_required');
  assertStoreModel(shopId, model);
  const store = STORES[shopId];
  requireThat(typeof model === 'string' && model && typeof variant === 'string' && variant, 'expected_model_variant_required');
  const mappingPath = path.join(path.resolve(stateDir), shopId, 'mappings', hash + '.json');
  const m = await json(mappingPath);
  requireThat(m.status === 'verified' && m.shop_id === shopId && m.seller_admin_ali_id === store.aliId && m.seller_member_seq === store.memberSeq && m.seller_minisite === store.minisite && m.image_hash === hash && m.model === model && m.variant === variant && Number.isSafeInteger(m.platform_image_id), 'mapping_identity_or_variant_mismatch');
  const asset = await prepareAsset({ indexPath: m.source_index, relativePath: m.source_selector });
  requireThat(asset.asset.sha256 === hash && asset.entry.model === model && asset.entry.variant === variant && m.platform_image_hash === hash && m.platform_response_hash === asset.asset.md5, 'mapping_source_mismatch');
  if (isDetailEntry(asset.entry)) {
    requireThat(m.asset_role === 'detail' && m.automatic_listing_allowed === asset.entry.automatic_listing_allowed
      && m.detail_order === asset.entry.detail_order && m.source_path === asset.entry.source_path && m.source_folder === asset.entry.source_folder,
    'detail_mapping_policy_mismatch');
    requireThat(allowManualOnly || m.automatic_listing_allowed === true, 'automatic_listing_not_allowed');
    if (m.adopted_existing_detail === true) {
      requireThat(m.platform_group_id === null || Number.isSafeInteger(m.platform_group_id) && m.platform_group_id > 0, 'detail_adoption_group_invalid');
      requireThat(path.isAbsolute(m.adoption_evidence_path || '') && /^[a-f0-9]{64}$/.test(m.adoption_evidence_sha256), 'detail_adoption_evidence_required');
      const evidenceBytes = await fs.readFile(m.adoption_evidence_path);
      requireThat(sha256(evidenceBytes) === m.adoption_evidence_sha256, 'detail_adoption_evidence_changed');
      const evidence = JSON.parse(evidenceBytes.toString('utf8'));
      requireThat([evidence.before, evidence.after].every(i => i?.adminAliId === store.aliId && i.adminMbrSeq === store.memberSeq && i.minisite === store.minisite)
        && evidence.item?.id === m.platform_image_id && evidence.item.memberSeq === store.memberSeq && evidence.item.groupId === m.platform_group_id
        && evidence.item.photobankImageMetadata?.hashCode === asset.asset.md5 && evidence.item.photobankImageMetadata.size === asset.asset.bytes
        && evidence.item.photobankImageMetadata.width === asset.asset.width && evidence.item.photobankImageMetadata.height === asset.asset.height
        && evidence.cdn?.sha256 === hash && evidence.cdn.url === m.image_url && evidence.cdn.bytes === asset.asset.bytes, 'detail_adoption_evidence_mismatch');
    } else requireThat(m.platform_group_id === store.groupId, 'mapping_identity_or_variant_mismatch');
  } else {
    requireThat(m.platform_group_id === store.groupId && !m.adopted_existing_detail, 'mapping_identity_or_variant_mismatch');
  }
  const u = new URL(m.image_url);
  requireThat(u.protocol === 'https:' && /^sc\d+\.alicdn\.com$/.test(u.hostname) && u.pathname.startsWith('/kf/'), 'mapping_url_invalid');
  return { shop_id: shopId, model, variant, platform_image_id: m.platform_image_id, image_url: m.image_url, image_hash: hash, platform_response_hash: m.platform_response_hash, verified_at: m.verified_at, mapping_path: mappingPath,
    ...(isDetailEntry(asset.entry) ? { asset_role: 'detail', detail_order: m.detail_order, automatic_listing_allowed: m.automatic_listing_allowed } : {}) };
}
