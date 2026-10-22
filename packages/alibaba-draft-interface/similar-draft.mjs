import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadDraftBindings } from './local-bindings.mjs';

export const { SOURCE_ID, SELLER_ID, PRIMARY_SHOP_ID, STORE_BINDINGS } = loadDraftBindings();

// Native submitDraft fields and data cleanup from main-cgs 7.1.124.
// Scope is frozen in each batch manifest; the legacy entry retains its DADB scope.
export function buildDraftBody(model, runId, scope = { sourceId: SOURCE_ID, sellerId: SELLER_ID }) {
  const fail = message => { throw new Error(message); };
  const g = model.models?.global, original = model.models?.formValues;
  if (g?.id !== scope.sourceId || g.adminAliId !== scope.sellerId || g.pubType !== 'similarPost') fail('source_or_seller_mismatch');
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
  if (g.globalSwitcher?.clearUnsupportedGalleryText && ['detailImage', 'companyImage'].some(k => body[k]?.some(a => !a.supportText && Number(a.value) >= 0 && a.imageList?.some(i => i.generalText)))) fail('gallery_confirmation_required');
  const action = model.components.draftBtn?.props?.action;
  const url = new URL(action, 'https://post.alibaba.com/product/');
  if (url.origin !== 'https://post.alibaba.com' || url.pathname !== '/product/submitDraft.json' || url.searchParams.get('pubType') !== 'similarPost' || url.searchParams.get('from') !== 'common' || url.searchParams.get('notRefresh') !== 'false') fail('unexpected_draft_action');
  return { url: url.href, fields: { catId: g.catId, itemId: g.id, jsonBody: JSON.stringify(body) }, removed, body };
}

export async function browserTask(p, makeBody) {
  const ensure = (ok, msg) => { if (!ok) throw new Error(msg); };
  const scope = p.scope;
  ensure(scope && Number.isSafeInteger(scope.sourceId) && Number.isSafeInteger(scope.sellerId) && typeof scope.minisite === 'string', 'explicit_scope_required');
  const safe = x => JSON.parse(JSON.stringify(x, (k, v) => /token|cookie|authorization|session|secret|password|credential|connectId/i.test(k) ? undefined : v));
  const identity = async () => {
    const r = await fetch('https://i.alibaba.com/ajax/sellerProfileAjax.do', { credentials: 'include' });
    ensure(r.ok, 'identity_http_error');
    const s = await r.json();
    ensure(s.adminAliId === scope.sellerId && s.minisite === scope.minisite, 'seller_mismatch');
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
    ensure(j.data.noIcmpResult.models.global.adminAliId === scope.sellerId, 'init_seller_mismatch');
    return { model: j.data.noIcmpResult, tokenName, tokenValue };
  };
  const stats = m => {
    const f = m.models.formValues;
    return { title: f.productTitle, sku: f.sku?.length || 0, mainImages: f.scImages?.list?.length || 0,
      detailImages: f.detailImage?.reduce((n, x) => n + (x.imageList?.length || 0), 0) || 0,
      companyImages: f.companyImage?.reduce((n, x) => n + (x.imageList?.length || 0), 0) || 0, faqs: f.companyFaqDesc?.length || 0 };
  };
  ensure(p.sourceId === scope.sourceId && Number.isSafeInteger(p.sourceId), 'source_scope');
  const jobs = window.__dadbDraftJobs ||= {};
  if (p.op === 'prepare') {
    ensure(!jobs[p.runId], 'browser_job_exists');
    // Reserve synchronously, before identity/init awaits can interleave.
    jobs[p.runId] = { runId: p.runId, state: 'preparing', attempted: false };
    const seller = await identity();
    const source = await readModel(p.sourceId, 'edit');
    const similar = await readModel(p.sourceId, 'similar');
    if (scope.expectedModel) ensure(JSON.stringify(source.model.models.formValues.icbuCatProp).includes(scope.expectedModel), 'model_mismatch');
    const payload = makeBody(similar.model, p.runId, scope);
    jobs[p.runId] = { runId: p.runId, state: 'prepared', source, similar, payload, attempted: false };
    return { seller, source: safe(source.model.models.formValues), initial: safe(similar.model.models.formValues), sourceStats: stats(source.model), initialStats: stats(similar.model), request: { url: payload.url, catId: payload.fields.catId, itemId: payload.fields.itemId, removed: payload.removed, payload: safe(payload.body) } };
  }
  const job = jobs[p.runId];
  ensure(job?.runId === p.runId, 'browser_job_missing');
  if (p.op === 'preflight') {
    ensure(job.state === 'prepared' && !job.attempted && !job.saveReserved, 'already_attempted_reconcile_only');
    ensure(JSON.stringify(makeBody(job.similar.model, p.runId, scope)) === JSON.stringify(job.payload), 'prepared_data_changed');
    return { seller: await identity(), runId: p.runId };
  }
  if (p.op === 'saveOnce') {
    ensure(job.state === 'prepared' && !job.attempted && !job.saveReserved, 'already_attempted_reconcile_only');
    job.saveReserved = true;
    await identity();
    ensure(JSON.stringify(makeBody(job.similar.model, p.runId, scope)) === JSON.stringify(job.payload), 'prepared_data_changed');
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
export async function browserBatchTask(p, task, makeBody) {
  const ensure = (ok, msg) => { if (!ok) throw new Error(msg); };
  ensure([1, 2].includes(p.jobs?.length) && new Set(p.jobs).size === p.jobs.length, 'batch_scope');
  if (p.op === 'prepare') {
    ensure(!window.__dadbDraftBatch, 'browser_batch_exists_reconcile_first');
    window.__dadbDraftBatch = { batchId: p.batchId, jobs: p.jobs, saveDispatched: false };
  }
  const batch = window.__dadbDraftBatch;
  ensure(batch?.batchId === p.batchId && JSON.stringify(batch.jobs) === JSON.stringify(p.jobs), 'batch_mismatch');
  if (p.op === 'saveOnce') {
    ensure(!batch.saveDispatched, 'batch_already_attempted_reconcile_only');
    await Promise.all(p.jobs.map(runId => task({ op: 'preflight', sourceId: p.sourceId, runId, scope: p.scope }, makeBody)));
    batch.saveDispatched = true;
    if (p.startAt) {
      ensure(Number.isFinite(p.startAt) && p.startAt - Date.now() <= 15000, 'invalid_start_time');
      await new Promise(resolve => setTimeout(resolve, Math.max(0, p.startAt - Date.now())));
    }
  }
  const results = await Promise.allSettled(p.jobs.map(async runId => {
    const value = await task({ op: p.op, sourceId: p.sourceId, runId, scope: p.scope }, makeBody);
    const job = window.__dadbDraftJobs[runId];
    if (p.op === 'saveOnce') { job.endedMs = performance.now(); job.endedAt = new Date().toISOString(); }
    return { runId, value, ...(p.op === 'saveOnce' ? { startedMs: job.startedMs, endedMs: job.endedMs, startedAt: job.startedAt, endedAt: job.endedAt } : {}) };
  }));
  return results.map((r, i) => r.status === 'fulfilled' ? { status: r.status, ...r.value } : { status: r.status, runId: p.jobs[i], error: r.reason?.message || 'operation_failed' });
}

export async function createConcurrentDraftAdapter({ cdp, runDir, shop = PRIMARY_SHOP_ID, sourceId = SOURCE_ID, count = 2, expectedModel }) {
  const binding = STORE_BINDINGS[shop];
  if (!binding || !Number.isSafeInteger(sourceId) || sourceId <= 0 || ![1, 2].includes(count)) throw new Error('batch_scope');
  await fs.mkdir(runDir, { recursive: true });
  const manifestPath = path.join(runDir, 'manifest.json');
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    manifest = { batchId: crypto.randomUUID(), shop, sourceId, sellerId: binding.sellerId,
      scope: { ...binding, sourceId, expectedModel }, jobs: Array.from({ length: count }, () => crypto.randomUUID()), allowedPostCount: count };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  }
  if (manifest.sourceId !== sourceId || manifest.sellerId !== binding.sellerId || manifest.jobs.length !== count || (manifest.shop && manifest.shop !== shop)) throw new Error('manifest_scope');
  const write = (name, value) => fs.writeFile(path.join(runDir, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const call = async (op, extra = {}) => {
    const expression = '(' + browserBatchTask.toString() + ')(' + JSON.stringify({ ...manifest, op, ...extra }) + ',' + browserTask.toString() + ',' + buildDraftBody.toString() + ')';
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, { timeoutMs: 60000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'browser_operation_failed');
    if (!r.result || !Object.hasOwn(r.result, 'value')) throw new Error('browser_result_missing');
    return r.result.value;
  };
  return {
    manifest,
    async prepare() { const result = await call('prepare'); await write('prepared.json', result); return result; },
    async saveOnce({ startAt } = {}) {
      await write('batch-save-intent.json', { ...manifest, at: new Date().toISOString(), startAt });
      for (const runId of manifest.jobs) await write(runId + '-save-intent.json', { runId, batchId: manifest.batchId, allowedPostCount: 1 });
      try {
        const result = await call('saveOnce', { startAt });
        await write('save-receipts.json', result);
        for (const row of result) await write(row.runId + '-receipt.json', row);
        return result;
      } catch {
        await write('save-unknown.json', { batchId: manifest.batchId, status: 'reconcile_only' });
        throw new Error('save_result_unknown_reconcile_only');
      }
    },
    async readback() {
      const result = await call('readback'); await write('readback.json', result);
      for (const row of result) await write(row.runId + '-readback.json', row);
      return result;
    },
    preflight: () => call('preflight'),
    receipt: () => call('receipt')
  };
}

export function createSingleDraftAdapter({ cdp, runDir }) {
  const runId = crypto.randomUUID();
  const call = async op => {
    const scope = { ...STORE_BINDINGS[PRIMARY_SHOP_ID], sourceId: SOURCE_ID };
    const expression = '(' + browserTask.toString() + ')(' + JSON.stringify({ op, sourceId: SOURCE_ID, runId, scope }) + ',' + buildDraftBody.toString() + ')';
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, { timeoutMs: 45000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'browser_operation_failed');
    if (!r.result || !Object.hasOwn(r.result, 'value')) throw new Error('browser_result_missing');
    return r.result.value;
  };
  const write = async (name, value) => {
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  };
  return {
    runId,
    async prepare() { const value = await call('prepare'); await write('prepared.json', { runId, sourceId: SOURCE_ID, at: new Date().toISOString(), ...value }); return value; },
    async saveOnce() {
      // Durable intent before the only write. Any subsequent call, even from a
      // new adapter instance, fails on the exclusive marker instead of retrying.
      await write('save-intent.json', { runId, sourceId: SOURCE_ID, at: new Date().toISOString(), operation: 'save_one_similar_draft', allowedPostCount: 1 });
      try { const value = await call('saveOnce'); await write('save-receipt.json', value); return value; }
      catch (e) { await write('save-unknown.json', { runId, status: 'reconcile_only', message: e.message.replace(/(?:https?:\/\/[^\s?]+)\?[^\s]+/g, '[url redacted]') }); throw new Error('save_result_unknown_reconcile_only'); }
    },
    async readback() { const value = await call('readback'); await write('readback.json', value); return value; },
    receipt: () => call('receipt')
  };
}
