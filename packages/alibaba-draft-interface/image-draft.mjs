import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { STORES, DADB, assertStoreModel } from '../alibaba-photobank/index.mjs';
import { resolveListingImages } from '../alibaba-photobank/listing-images.mjs';

// Native main-cgs 7.1.124 protocol, adapted from similar-draft.mjs.
// Separate entry: every task must explicitly supply its source product ID.
export function buildImageDraftBody(model, runId, options, primaryShopId = DADB.id) {
  const fail = message => { throw new Error(message); };
  const g = model.models?.global, original = model.models?.formValues;
  if (g?.id !== options.sourceId || g.adminAliId !== options.sellerId || g.pubType !== 'similarPost') fail('source_or_seller_mismatch');
  const models = original?.icbuCatProp?.['p-3'];
  if (!Array.isArray(models) || models.length !== 1 || models[0].text !== options.model) fail('source_model_mismatch');
  if (options.shopId !== primaryShopId && /^D/i.test(options.model.normalize('NFKC').trim())) fail('d_model_forbidden_in_new_old_store');
  for (const check of options.sourceChecks || []) {
    if (JSON.stringify(check.path.reduce((v,k) => v?.[k], original)) !== JSON.stringify(check.equals)) fail('source_variant_check_failed');
  }
  if (!options.variant || !Array.isArray(options.images) || options.images.length < 1 || options.images.length > 6 || new Set(options.images.map(i => i.fileId)).size !== options.images.length || options.images.some((i,n) => !Number.isSafeInteger(i.fileId) || i.fileId <= 0 || i.fileFlag !== 'add' || i.fileDestOrder !== n+1)) fail('invalid_mapped_images');
  if (g.currentPage !== 0 || !original?.productTitle || !Array.isArray(original.sku)) fail('unsupported_form');
  const form = structuredClone(original), removed = [];
  for (const key of Object.keys(form)) {
    if (!model.components[key]) fail('unknown_form_component:' + key);
    if (model.components[key].props?.visible === false && key !== 'productDescType') {
      delete form[key]; removed.push(key);
    }
  }
  let extra = {};
  try { extra = JSON.parse(form.extraData || '{}'); } catch { fail('invalid_extra_data'); }
  extra.uniqueId = runId.replaceAll('-', '');
  form.extraData = JSON.stringify(extra);
  if (form.scPrice?.value === 1 && Array.isArray(form.sku)) form.sku.forEach(row => { if (row) delete row.price; });
  else if (form.scPrice?.value === 3) delete form.ladderPrice;
  const body = Object.assign({}, g.cache || {}, g.value || {}, form);
  if (g.globalSwitcher?.enableDetailStruct) {
    const structuredDetail = g.globalSwitcher.enableAiDetail
      ? original.productDescType?.value === 4
      : ['detailImage', 'textDesc', 'companyImage', 'companyDesc', 'companyFaqDesc'].some(k => model.components[k]?.props?.visible !== false);
    for (const key of structuredDetail ? ['superText', 'magicEditor', 'smartEditor'] : ['detailImage', 'textDesc', 'companyImage', 'companyDesc', 'companyFaqDesc']) delete body[key];
  }
  for (const key of ['productTitle', 'textDesc', 'scImages', 'detailImage', 'companyImage', 'companyDesc', 'companyFaqDesc']) {
    if (original[key] !== undefined && JSON.stringify(body[key]) !== JSON.stringify(original[key])) fail('protected_field_changed:' + key);
  }
  body.scImages = { ...original.scImages, list: structuredClone(options.images) };
  if (g.globalSwitcher?.clearUnsupportedGalleryText && ['detailImage', 'companyImage'].some(k => body[k]?.some(a => !a.supportText && Number(a.value) >= 0 && a.imageList?.some(i => i.generalText)))) fail('gallery_confirmation_required');
  const action = model.components.draftBtn?.props?.action;
  const url = new URL(action, 'https://post.alibaba.com/product/');
  if (url.origin !== 'https://post.alibaba.com' || url.pathname !== '/product/submitDraft.json' || url.searchParams.get('pubType') !== 'similarPost' || url.searchParams.get('from') !== 'common' || url.searchParams.get('notRefresh') !== 'false') fail('unexpected_draft_action');
  return { url: url.href, fields: { catId: g.catId, itemId: g.id, jsonBody: JSON.stringify(body) }, removed, body };
}

export async function imageBrowserTask(p, makeBody) {
  const ensure = (ok, msg) => { if (!ok) throw new Error(msg); };
  const safe = x => JSON.parse(JSON.stringify(x, (k, v) => /token|cookie|authorization|session|secret|password|credential|connectId/i.test(k) ? undefined : v));
  const identity = async () => {
    const r = await fetch('https://i.alibaba.com/ajax/sellerProfileAjax.do', { credentials: 'include' });
    ensure(r.ok, 'identity_http_error');
    const s = await r.json();
    ensure(s.adminAliId === p.options.sellerId && s.minisite === p.minisite, 'seller_mismatch');
    return { aliId: s.adminAliId, minisite: s.minisite };
  };
  const readModel = async (id, mode) => {
    const q = mode === 'similar' ? '?pubType=similarPost&itemId=' + id + '&behavior=copyNew' : '?itemId=' + id + (mode === 'draft' ? '&pubAction=draft' : '');
    const page = await fetch('https://post.alibaba.com/product/publish.htm' + q, { credentials: 'include' });
    ensure(page.ok, 'page_http_error');
    const html = await page.text();
    const tokenName = html.match(/tokenName:\s*['"]([^'"]+)['"]/)?.[1];
    const tokenValue = html.match(/tokenValue:\s*['"]([^'"]+)['"]/)?.[1];
    ensure(tokenName === 'X-XSRF-TOKEN' && tokenValue, 'csrf_missing');
    ensure(html.includes('/posting/main-cgs/7.1.124/publish-splitpacking.js'), 'source_version_changed');
    const r = await fetch('https://post.alibaba.com/product/asyRender.json' + q + '&' + encodeURIComponent(tokenName) + '=' + encodeURIComponent(tokenValue), {
      credentials: 'include', headers: { [tokenName]: tokenValue, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
    });
    ensure(r.ok, 'init_http_error');
    const j = await r.json();
    ensure(j.success === true && j.data?.noIcmpResult?.models?.global?.id === id, 'init_not_found');
    ensure(j.data.noIcmpResult.models.global.adminAliId === p.options.sellerId, 'init_seller_mismatch');
    return { model: j.data.noIcmpResult, tokenName, tokenValue };
  };
  const stats = m => {
    const f = m.models.formValues;
    return { title: f.productTitle, sku: f.sku?.length || 0, mainImages: f.scImages?.list?.length || 0,
      detailImages: f.detailImage?.reduce((n, x) => n + (x.imageList?.length || 0), 0) || 0,
      companyImages: f.companyImage?.reduce((n, x) => n + (x.imageList?.length || 0), 0) || 0, faqs: f.companyFaqDesc?.length || 0 };
  };
  ensure(Number.isSafeInteger(p.sourceId) && p.sourceId > 0 && p.options.sourceId === p.sourceId, 'source_scope');
  const jobs = window.__mappedImageDraftJobs ||= {};
  if (p.op === 'prepare') {
    ensure(!jobs[p.runId], 'browser_job_exists');
    // Reserve synchronously, before identity/init awaits can interleave.
    jobs[p.runId] = { runId: p.runId, state: 'preparing', attempted: false };
    const seller = await identity();
    const source = await readModel(p.sourceId, 'edit');
    const similar = await readModel(p.sourceId, 'similar');
    const payload = makeBody(similar.model, p.runId, p.options, p.primaryShopId);
    jobs[p.runId] = { runId: p.runId, state: 'prepared', source, similar, payload, attempted: false };
    return { seller, source: safe(source.model.models.formValues), initial: safe(similar.model.models.formValues), sourceStats: stats(source.model), initialStats: stats(similar.model), request: { url: payload.url, catId: payload.fields.catId, itemId: payload.fields.itemId, removed: payload.removed, payload: safe(payload.body) } };
  }
  const job = jobs[p.runId];
  ensure(job?.runId === p.runId, 'browser_job_missing');
  if (p.op === 'preflight') {
    ensure(job.state === 'prepared' && !job.attempted && !job.saveReserved, 'already_attempted_reconcile_only');
    ensure(JSON.stringify(makeBody(job.similar.model, p.runId, p.options, p.primaryShopId)) === JSON.stringify(job.payload), 'prepared_data_changed');
    return { seller: await identity(), runId: p.runId };
  }
  if (p.op === 'saveOnce') {
    ensure(job.state === 'prepared' && !job.attempted && !job.saveReserved, 'already_attempted_reconcile_only');
    job.saveReserved = true;
    await identity();
    ensure(JSON.stringify(makeBody(job.similar.model, p.runId, p.options, p.primaryShopId)) === JSON.stringify(job.payload), 'prepared_data_changed');
    const url = new URL(job.payload.url);
    url.searchParams.set(job.similar.tokenName, job.similar.tokenValue);
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', [job.similar.tokenName]: job.similar.tokenValue };
    if (window.__awsc?.umidToken) { headers['awsc-token'] = window.__awsc.umidToken; headers['awsc-token-type'] = 'pc'; }
    job.attempted = true;
    job.startedAt = new Date().toISOString();
    job.startedMs = performance.now();
    try {
      const r = await fetch(url.href, { method: 'POST', credentials: 'include', headers, body: new URLSearchParams(job.payload.fields).toString() });
      const text = await r.text();
      let response;
      try { response = JSON.parse(text); } catch { job.receipt = { httpStatus: r.status, status: 'unknown_non_json', bytes: text.length }; return job.receipt; }
      job.response = response;
      const msg = response.models?.globalMessage || response.data?.models?.globalMessage;
      let newId = null;
      if (msg?.type === 'success' && msg.successUrl) {
        const success = new URL(msg.successUrl, 'https://post.alibaba.com');
        const id = Number(success.searchParams.get('itemId'));
        if (Number.isSafeInteger(id) && id !== p.sourceId && success.searchParams.get('pubAction') === 'draft') newId = id;
      }
      job.newId = newId;
      job.receipt = { httpStatus: r.status, status: newId ? 'saved_pending_readback' : 'requires_reconciliation', newDraftId: newId, response: safe(response) };
      return job.receipt;
    } catch (e) { job.receipt = { status: 'unknown_transport_result', error: e.name }; return job.receipt; }
  }
  if (p.op === 'readback') {
    await identity();
    const source = await readModel(p.sourceId, 'edit');
    const id = job.newId || p.newDraftId;
    const draft = id ? await readModel(id, 'draft') : null;
    if (draft) ensure(draft.model.models.global.pubAction === 'draft', 'not_draft');
    return { seller: await identity(), newDraftId: id || null, sourceAfter: safe(source.model.models.formValues), draft: draft ? safe(draft.model.models.formValues) : null, draftStats: draft ? stats(draft.model) : null, draftGlobal: draft ? { id: draft.model.models.global.id, pubAction: draft.model.models.global.pubAction, pubType: draft.model.models.global.pubType } : null };
  }
  if (p.op === 'receipt') return job.receipt || { status: job.attempted ? 'requires_reconciliation' : 'not_attempted' };
  throw new Error('unknown_operation');
}

// One extension command dispatches both HTTP requests; no detached promises.

export async function createImageDraftAdapter({ cdp, runDir, sourceId, shopId, model, variant, template = 'T01', stateDir, sourceChecks = [] }) {
  // No default source ID and no implicit upload fallback.
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0) throw Error('explicit_source_product_id_required');
  assertStoreModel(shopId, model);
  const selection = await resolveListingImages({ shopId, model, variant, template, stateDir });
  const store = STORES[shopId], runId = crypto.randomUUID();
  const options = structuredClone({ sourceId, shopId, sellerId: store.aliId, model, variant, images: selection.list, sourceChecks });
  const write = async (name, value) => {
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  };
  const call = async op => {
    const expression = '(' + imageBrowserTask.toString() + ')(' + JSON.stringify({ op, sourceId, runId, options, primaryShopId: DADB.id, minisite: store.minisite }) + ',' + buildImageDraftBody.toString() + ')';
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, { timeoutMs: 45000 });
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || 'browser_operation_failed');
    if (!r.result || !Object.hasOwn(r.result, 'value')) throw Error('browser_result_missing');
    return r.result.value;
  };
  let prepared;
  return {
    runId, selection: structuredClone(selection),
    async prepare() {
      await write('selection.json', { runId, sourceId, ...selection, sourceChecks });
      prepared = await call('prepare');
      await write('prepared.json', { runId, sourceId, ...prepared });
      return prepared;
    },
    async saveOnce() {
      if (!prepared) throw Error('prepare_required');
      // Refresh local approvals/hash validation before dispatch, without bank I/O.
      const current = await resolveListingImages({ shopId, model, variant, template, stateDir });
      if (JSON.stringify(current.list) !== JSON.stringify(selection.list)) throw Error('mapping_changed');
      await write('save-intent.json', { runId, sourceId, shopId, operation: 'save_one_image_draft', allowedPostCount: 1, imageIds: selection.images.map(i => i.platform_image_id), at: new Date().toISOString() });
      try { const r = await call('saveOnce'); await write('save-receipt.json', r); return r; }
      catch (e) { await write('save-unknown.json', { runId, status: 'reconcile_only' }); throw Error('save_result_unknown_reconcile_only'); }
    },
    async readback() {
      if (!prepared) throw Error('prepare_required');
      const r = await call('readback');
      await write('readback.json', r);
      const actual = r.draft?.scImages?.list;
      if (!r.newDraftId || r.draftGlobal?.pubAction !== 'draft' || actual?.length !== selection.images.length) throw Error('draft_or_image_count_mismatch');
      if (JSON.stringify(prepared.source) !== JSON.stringify(r.sourceAfter)) throw Error('source_product_changed');
      for (const key of ['productTitle', 'textDesc', 'detailImage', 'companyImage', 'companyDesc', 'companyFaqDesc']) {
        if (JSON.stringify(prepared.initial[key]) !== JSON.stringify(r.draft[key])) throw Error('draft_content_changed:' + key);
      }
      const images = selection.images.map((image, n) => {
        if (actual[n].fileURL !== image.image_url) throw Error('draft_image_url_or_order_mismatch:' + n);
        if (actual[n].fileId !== image.platform_image_id) throw Error('draft_image_id_mismatch:' + n);
        return { ...image, submitted_file_id: image.platform_image_id, readback_file_id: actual[n].fileId ?? null, readback_url: actual[n].fileURL, product_id: r.newDraftId, product_assignment_verified: true, status: 'draft' };
      });
      const verification = { runId, shop_id: shopId, source_product_id: sourceId, draft_product_id: r.newDraftId, draft_url: 'https://post.alibaba.com/product/publish.htm?itemId=' + r.newDraftId + '&pubAction=draft', model, variant, template, status: 'verified_draft_images', source_unchanged: true, copy_content_unchanged: true, all_readback_ids_match: images.every(i => i.readback_file_id === i.platform_image_id), images, upload_count: 0, gallery_scan_count: 0, formal_publish_count: 0, verified_at: new Date().toISOString() };
      await write('image-assignment.json', verification);
      return verification;
    },
    receipt: () => call('receipt')
  };
}
