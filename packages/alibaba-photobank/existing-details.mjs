import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { prepareAsset, assertStoreModel, STORES, DEFAULT_STATE_DIR } from './index.mjs';

const requireThat = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const optionalJson = async file => { try { return await readJson(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try { await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}

// All browser requests in this helper are GETs. A cached item only selects an ID;
// it never substitutes for fresh identity, metadata and original-byte checks.
export async function existingDetailBrowserTask(p) {
  const fail = code => { throw Error(code); };
  if (!['https://photobank.alibaba.com', 'https://hz-productposting.alibaba.com'].includes(location.origin)) fail('wrong_origin');
  const identity = async () => {
    const r = await fetch('https://i.alibaba.com/ajax/sellerProfileAjax.do', { credentials: 'include', cache: 'no-store' });
    if (!r.ok) fail('identity_http_error');
    const d = await r.json();
    if (d.adminAliId !== p.store.aliId || d.adminMbrSeq !== p.store.memberSeq || d.minisite !== p.store.minisite) fail('seller_identity_mismatch');
    return { adminAliId: d.adminAliId, adminMbrSeq: d.adminMbrSeq, minisite: d.minisite };
  };
  const before = await identity();
  const key = p.store.id + '_' + p.asset.sha256;
  const assertPendingSettled = pending => {
    if (!pending) return;
    if (pending.storeId !== p.store.id || pending.sha256 !== p.asset.sha256) fail('pending_identity_mismatch');
    if (!(['registered', 'file_uploaded', 'prepared'].includes(pending.phase)
      || (pending.phase === 'register_post_started' && pending.registerCompletedAt && pending.registerResult?.duplicateCount > 0))) fail('pending_post_requires_reconciliation');
  };
  assertPendingSettled(window.__codexPhotobankUploadsV1?.[key]);
  if (p.op === 'cleanup') {
    const pending = window.__codexPhotobankUploadsV1?.[key];
    if (pending) {
      delete window.__codexPhotobankUploadsV1[key];
      if (!Object.keys(window.__codexPhotobankUploadsV1).length) delete window.__codexPhotobankUploadsV1;
    }
    return { before, after: await identity(), cleaned: Boolean(pending) };
  }
  if (p.op !== 'read') fail('unknown_existing_detail_operation');
  const response = await fetch('https://photobank.alibaba.com/fetch/groups/-1', { credentials: 'include', cache: 'no-store' });
  const groups = await response.json();
  if (!response.ok || !groups.success || !Array.isArray(groups.data)) fail('group_query_failed');
  let groupName = null;
  if (p.candidate.groupId !== null) {
    const matches = groups.data.filter(g => g.id === p.candidate.groupId);
    if (matches.length !== 1 || matches[0].aliMemberId !== p.store.memberSeq) fail('existing_group_mismatch');
    groupName = matches[0].name;
  }
  // -1 is the already verified whole-bank selector. We do not guess a selector
  // for null / ungrouped entries; the located live item must itself have null.
  const queryGroup = p.candidate.groupId === null ? '-1' : p.candidate.groupId;
  let total, found = null;
  const seen = new Set();
  for (let page = 1; page <= p.maxPages; page++) {
    const url = new URL('https://photobank.alibaba.com/fetch/bank');
    for (const [name, value] of Object.entries({ action: 'default', page, pageSize: p.pageSize, imageWidth: 350, imageHeight: 350,
      search: JSON.stringify({ groupId: queryGroup }) })) url.searchParams.set(name, value);
    const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
    const d = await r.json(), list = d.data?.list;
    if (!r.ok || !d.success || !Number.isSafeInteger(d.data?.total) || d.data.total < 0 || d.data.currentPage !== page || !Array.isArray(list)) fail('bank_query_failed');
    total ??= d.data.total;
    if (d.data.total !== total || Math.ceil(total / p.pageSize) > p.maxPages
      || list.length !== Math.min(p.pageSize, Math.max(0, total - (page - 1) * p.pageSize))) fail('incomplete_bank_page');
    for (const item of list) {
      if (!Number.isSafeInteger(item.id) || seen.has(item.id)) fail('invalid_bank_identity_or_pagination');
      seen.add(item.id);
      if (item.id === p.candidate.id) { if (found) fail('multiple_platform_duplicates'); found = item; }
    }
    // Selecting an explicit ID does not require claiming an entire gallery is unchanged.
    if (found || page * p.pageSize >= total) break;
  }
  if (!found) fail('existing_detail_not_found');
  const m = found.photobankImageMetadata;
  if (found.memberSeq !== p.store.memberSeq || found.groupId !== p.candidate.groupId || m?.hashCode !== p.asset.md5
    || m.size !== p.asset.bytes || m.width !== p.asset.width || m.height !== p.asset.height) fail('existing_detail_readback_mismatch');
  const url = new URL(found.imageUrl, 'https://photobank.alibaba.com');
  if (url.protocol !== 'https:' || !/^sc\d+\.alicdn\.com$/.test(url.hostname) || !url.pathname.startsWith('/kf/')) fail('invalid_cdn_url');
  const r = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  if (!r.ok) fail('cdn_http_error');
  const bytes = await r.arrayBuffer();
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
  if (bytes.byteLength !== p.asset.bytes || digest !== p.asset.sha256) fail('cdn_bytes_mismatch');
  const pending = window.__codexPhotobankUploadsV1?.[key];
  return { before, after: await identity(), verifiedAt: new Date().toISOString(), item: found, groupName,
    lookup: { groupId: queryGroup, pages: Math.ceil(seen.size / p.pageSize), total },
    cdn: { url: url.href, status: r.status, bytes: bytes.byteLength, sha256: digest },
    pending: pending ? { phase: pending.phase, sha256: pending.sha256, storeId: pending.storeId, upload: pending.upload,
      registerResult: pending.registerResult, registerStartedAt: pending.registerStartedAt, registerCompletedAt: pending.registerCompletedAt } : null };
}

/** Read-only platform adoption; the only writes are canonical local evidence, job and mapping files. */
export async function adoptExistingDetail({ cdp, shopId, indexPath, relativePath, item, cachedItem,
  stateDir = DEFAULT_STATE_DIR, pageSize = 100, maxPages = 100 }) {
  const prepared = await prepareAsset({ indexPath, relativePath });
  const { asset, entry } = prepared;
  assertStoreModel(shopId, entry.model);
  requireThat(entry.asset_role === 'detail' && /^DETAIL\d+$/.test(entry.slot), 'detail_only_adoption');
  requireThat(cdp && typeof cdp.send === 'function', 'builtin_cdp_required');
  requireThat(Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 100 && Number.isInteger(maxPages) && maxPages > 0 && maxPages <= 100, 'invalid_lookup_budget');
  const candidate = item ?? cachedItem, store = STORES[shopId];
  requireThat(candidate && Number.isSafeInteger(candidate.id) && Object.hasOwn(candidate, 'groupId')
    && (candidate.groupId === null || Number.isSafeInteger(candidate.groupId) && candidate.groupId > 0)
    && candidate.memberSeq === store.memberSeq && candidate.photobankImageMetadata?.hashCode === asset.md5, 'invalid_existing_detail_candidate');
  const root = path.join(path.resolve(stateDir), shopId), lockPath = path.join(root, 'upload.lock'), token = crypto.randomUUID();
  await fs.mkdir(root, { recursive: true });
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); }
  catch (e) { if (e.code === 'EEXIST') throw Object.assign(Error('store_upload_locked: ' + lockPath), { code: 'store_upload_locked' }); throw e; }
  try {
    await lock.writeFile(JSON.stringify({ token, owner: 'codex-existing-detail-adoption', at: new Date().toISOString() }));
    const mappingPath = path.join(root, 'mappings', asset.sha256 + '.json'), jobPath = path.join(root, 'jobs', asset.sha256 + '.json');
    const prior = await optionalJson(mappingPath), job = await optionalJson(jobPath);
    requireThat(!prior || prior.shop_id === shopId && prior.model === entry.model && prior.variant === entry.variant && prior.platform_image_id === candidate.id, 'existing_mapping_conflict');
    requireThat(!job || job.shop_id === shopId && job.image_hash === asset.sha256 && job.source_index === prepared.sourceIndex && job.source_selector === relativePath, 'existing_job_identity_mismatch');
    const call = async op => {
      const r = await cdp.send('Runtime.evaluate', { expression: '(' + existingDetailBrowserTask.toString() + ')(' + JSON.stringify({ op, store, asset, candidate, pageSize, maxPages }) + ')', awaitPromise: true, returnByValue: true }, { timeoutMs: 180000 });
      if (r.exceptionDetails) {
        const message = r.exceptionDetails.exception?.description || r.exceptionDetails.text || '';
        throw Error(message.match(/(?:Error:\s*)?([a-z][a-z0-9_]{3,})/)?.[1] || 'existing_detail_browser_failed');
      }
      requireThat(r.result && Object.hasOwn(r.result, 'value'), 'browser_result_missing');
      return r.result.value;
    };
    const verified = await call('read');
    requireThat(hash(await fs.readFile(entry.local_path)) === asset.sha256 && hash(await fs.readFile(entry.source_path)) === asset.sha256, 'source_changed_during_adoption');
    const runId = crypto.randomUUID(), runDir = path.join(root, 'runs', runId), evidencePath = path.join(runDir, 'existing-detail-readback.json');
    await writeJson(evidencePath, verified);
    const evidenceHash = hash(await fs.readFile(evidencePath));
    const mapping = { schema_version: 1, status: 'verified', action: 'reused_existing', transport: 'builtin-chrome-extension', shop_id: shopId,
      seller_admin_ali_id: store.aliId, seller_member_seq: store.memberSeq, seller_minisite: store.minisite,
      group_name: verified.groupName, platform_group_id: verified.item.groupId, adopted_existing_detail: true,
      adoption_evidence_path: evidencePath, adoption_evidence_sha256: evidenceHash,
      model: entry.model, variant: entry.variant, template: entry.template, slot: entry.slot,
      material_id: entry.material_id ?? null, material_version: entry.material_version ?? null,
      source_index: prepared.sourceIndex, source_selector: relativePath, local_path: entry.local_path,
      user_approval: entry.user_approval, approval_evidence: entry.approval_evidence, approval_evidence_sha256: entry.approval_evidence_sha256,
      asset_role: 'detail', source_language: entry.source_language, source_path: entry.source_path, source_folder: entry.source_folder,
      detail_order: entry.detail_order, automatic_listing_allowed: entry.automatic_listing_allowed,
      image_hash: asset.sha256, image_hash_algorithm: 'SHA-256', local_md5: asset.md5,
      platform_image_id: verified.item.id, image_url: verified.cdn.url, platform_filename: verified.item.filename,
      platform_response_hash: verified.item.photobankImageMetadata.hashCode, platform_response_hash_algorithm: 'MD5_verified',
      platform_image_hash: verified.cdn.sha256, platform_image_hash_algorithm: 'SHA-256', width: asset.width, height: asset.height, bytes: asset.bytes,
      verified_at: verified.verifiedAt, saved_at: verified.item.gmtCreate ?? null, ready_for_listing_image_reference: true,
      product_id: null, product_assignment_verified: false, ui_actions: { click: 0, fileChooser: 0, navigate: 0, reload: 0 },
      run_id: runId, batch_id: null, evidence_directory: runDir };
    await writeJson(mappingPath, mapping);
    await writeJson(jobPath, { ...job, schema_version: 1, shop_id: shopId, image_hash: asset.sha256, local_md5: asset.md5,
      source_index: prepared.sourceIndex, source_selector: relativePath, phase: 'verified', action: 'reused_existing', adopted_existing_detail: true,
      platform_image_id: mapping.platform_image_id, mapping_path: mappingPath, adoption_evidence_path: evidencePath,
      updated_at: new Date().toISOString() });
    const cleanup = await call('cleanup');
    await writeJson(path.join(runDir, 'adoption-complete.json'), { action: 'reused_existing', platform_posts: 0, mapping_path: mappingPath, cleanup });
    return { action: 'reused_existing', mapping, mappingPath, jobPath, platform_posts: 0, cleanup };
  } finally {
    await lock.close();
    if ((await optionalJson(lockPath))?.token === token) await fs.unlink(lockPath);
  }
}
