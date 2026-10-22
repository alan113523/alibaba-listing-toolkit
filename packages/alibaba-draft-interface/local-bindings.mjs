import { readFileSync } from 'node:fs';

export function loadDraftBindings(file = new URL('./.local/store-bindings.json', import.meta.url)) {
  const fail = () => { throw Error('local_draft_bindings_required_or_invalid'); };
  let config;
  try { config = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { fail(); }
  const entries = Object.entries(config?.stores || {});
  if (entries.length !== 3 || !entries.some(([id]) => id === config.primaryShopId) ||
      !Number.isSafeInteger(config.sourceId) || config.sourceId <= 0 ||
      !Number.isSafeInteger(config.sellerId) || config.sellerId <= 0) fail();
  const bindings = entries.map(([id, store]) => {
    if (!/^[a-z0-9_-]+$/.test(id) || !Number.isSafeInteger(store?.sellerId) || store.sellerId <= 0 ||
        store.minisite !== `https://${id}.en.alibaba.com/`) fail();
    return [id, Object.freeze({ sellerId: store.sellerId, minisite: store.minisite })];
  });
  const STORE_BINDINGS = Object.freeze(Object.fromEntries(bindings));
  if (new Set(bindings.map(([, store]) => store.sellerId)).size !== 3 ||
      STORE_BINDINGS[config.primaryShopId].sellerId !== config.sellerId) fail();
  return { SOURCE_ID: config.sourceId, SELLER_ID: config.sellerId, PRIMARY_SHOP_ID: config.primaryShopId, STORE_BINDINGS };
}
