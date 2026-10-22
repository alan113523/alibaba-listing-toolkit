import crypto from 'node:crypto';
import { loadDraftBindings } from './local-bindings.mjs';

export const canonical = value => JSON.stringify(value == null ? null : typeof value !== 'object' ? value : Array.isArray(value)
  ? value.map(v => JSON.parse(canonical(v)))
  : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))])));
const equal = (a, b) => canonical(a) === canonical(b);
const hash = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const normalizeSku = rows => rows?.map(({ skuId, allProps, index, ...rest }) => rest);
const normalizeDefinitions = rows => rows?.slice().sort((a, b) => String(a.value).localeCompare(String(b.value)));
const normalizeCustomization = text => {
  if (text == null || text === '') return text;
  const value = JSON.parse(text);
  return { ...value, customContent: value.customContent?.map(row => ({ ...row, customType: row.customType?.toLowerCase() })) };
};

export function verifyBatch({ manifest, prepared, receipts, readback }) {
  const rows = manifest.jobs.map(runId => {
    const p = prepared.find(r => r.runId === runId)?.value;
    const s = receipts.find(r => r.runId === runId);
    const r = readback.find(r => r.runId === runId)?.value;
    if (!p || !s || !r?.draft) throw new Error('incomplete_readback_reconcile_only:' + runId);
    const initial = p.initial, draft = r.draft;
    const changed = Object.keys({ ...p.source, ...r.sourceAfter }).filter(k => !equal(p.source[k], r.sourceAfter[k]));
    const differences = Object.keys({ ...initial, ...draft }).filter(k => !equal(initial[k], draft[k]));
    const normalizedFields = ['imageMedia', 'productKeywords', 'saleAttributesItems', 'scImages', 'sku', 'superText', 'extraData', 'sampleSku', 'newCustomizedServices'];
    const ordinary = Object.fromEntries(Object.keys(initial).filter(k => !normalizedFields.includes(k)).map(k => [k, equal(initial[k], draft[k])]));
    const { fileType, ...draftImages } = draft.scImages || {};
    const { active, ...draftMedia } = draft.imageMedia || {};
    const keywordList = values => (values || []).filter(x => String(x).trim());
    const inheritanceChecks = {
      ...ordinary,
      skuCombinations: equal(normalizeSku(initial.sku), normalizeSku(draft.sku)),
      sampleSkuCombinationsAndPrices: equal(normalizeSku(initial.sampleSku), normalizeSku(draft.sampleSku)),
      customizedServices: equal(normalizeCustomization(initial.newCustomizedServices), normalizeCustomization(draft.newCustomizedServices)),
      saleAttributeDefinitions: equal(normalizeDefinitions(initial.saleAttributesItems), normalizeDefinitions(draft.saleAttributesItems)),
      mainImageList: equal(initial.scImages?.list, draft.scImages?.list),
      imageSettings: equal(initial.scImages, draftImages),
      imageFileType: fileType === 'static' || fileType === initial.scImages?.fileType,
      mediaSettings: equal(initial.imageMedia, draftMedia) && (active === true || active === initial.imageMedia?.active),
      keywords: equal(keywordList(initial.productKeywords), keywordList(draft.productKeywords)),
      unusedRichText: String(initial.superText || '').trim() === String(draft.superText || '').trim(),
      extraData: equal(JSON.parse(p.request.payload.extraData), JSON.parse(draft.extraData)),
      traceId: JSON.parse(draft.extraData).uniqueId === runId.replaceAll('-', ''),
      noUnexpectedFields: differences.every(k => normalizedFields.includes(k))
    };
    const identityMatches = [p.seller, r.seller].every(x => x?.aliId === manifest.sellerId);
    const passed = changed.length === 0 && Object.values(inheritanceChecks).every(Boolean) && identityMatches && r.draftGlobal.pubAction === 'draft' && r.newDraftId === s.value?.newDraftId && r.newDraftId !== manifest.sourceId;
    return { runId, passed, sourceFieldsCompared: Object.keys(p.source).length, sourceChangedFields: changed,
      sourceBeforeSha256: hash(p.source), sourceAfterSha256: hash(r.sourceAfter), newDraftId: r.newDraftId,
      draftState: r.draftGlobal.pubAction, stats: r.draftStats, inheritanceChecks, serverNormalizedFields: differences,
      startedAt: s.startedAt, endedAt: s.endedAt, durationMs: s.endedMs - s.startedMs };
  });
  const idsUnique = new Set(rows.map(r => r.newDraftId)).size === manifest.jobs.length;
  const overlapMs = rows.length > 1 ? Math.max(0, Math.min(...receipts.map(r => r.endedMs)) - Math.max(...receipts.map(r => r.startedMs))) : null;
  return { status: rows.every(r => r.passed) && idsUnique ? 'verified' : 'failed', batchId: manifest.batchId,
    shop: manifest.shop || loadDraftBindings().PRIMARY_SHOP_ID, sellerId: manifest.sellerId, sourceId: manifest.sourceId,
    savePostCount: manifest.allowedPostCount, publishCount: 0, videoAssociationCount: 0,
    idsUnique, overlapMs, rows };
}
