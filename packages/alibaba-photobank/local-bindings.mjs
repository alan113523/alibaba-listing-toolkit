import { readFileSync } from 'node:fs';

// Machine-local identities are required; no sample or guessed account fallback.
export function loadStoreBindings(file = new URL('./.local/store-bindings.json', import.meta.url)) {
  const fail = () => { throw Error('local_store_bindings_required_or_invalid'); };
  let config;
  try { config = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { fail(); }
  const entries = Object.entries(config?.stores || {});
  if (entries.length !== 3 || !entries.some(([id]) => id === config.primaryShopId)) fail();
  const stores = entries.map(([id, store]) => {
    if (!/^[a-z0-9_-]+$/.test(id) || store?.id !== id ||
        !['aliId', 'memberSeq', 'groupId'].every(key => Number.isSafeInteger(store[key]) && store[key] > 0) ||
        store.minisite !== `https://${id}.en.alibaba.com/` || !store.groupName?.trim()) fail();
    return [id, Object.freeze({ id, aliId: store.aliId, memberSeq: store.memberSeq, minisite: store.minisite, groupId: store.groupId, groupName: store.groupName })];
  });
  if (new Set(stores.map(([, store]) => store.aliId)).size !== 3 ||
      new Set(stores.map(([, store]) => store.memberSeq)).size !== 3) fail();
  const STORES = Object.freeze(Object.fromEntries(stores));
  return { DADB: STORES[config.primaryShopId], STORES };
}
