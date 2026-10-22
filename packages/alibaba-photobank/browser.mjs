// Serialized through the built-in Chrome extension's documented CDP capability.
// No UI controls, external CDP sockets, exported cookies, or retrying POSTs.
export async function browserTask(p) {
  const fail = code => { throw new Error(code); };
  if (!['https://photobank.alibaba.com', 'https://hz-productposting.alibaba.com'].includes(location.origin)) fail('wrong_origin');
  if (['upload_many', 'register_many', 'verify_many'].includes(p.op)) {
    if (!Array.isArray(p.jobs) || !p.jobs.length || p.jobs.length > 9 || new Set(p.jobs.map(j => j.key)).size !== p.jobs.length) fail('invalid_browser_batch');
    const results = await Promise.allSettled(p.jobs.map(j => browserTask({ ...j, store: p.store, op: p.op.replace('_many', '') })));
    return results.map((r, i) => r.status === 'fulfilled' ? { key: p.jobs[i].key, status: r.status, value: r.value } : { key: p.jobs[i].key, status: r.status, code: /^[a-z][a-z0-9_]+$/.test(r.reason?.message || '') ? r.reason.message : 'batch_operation_failed' });
  }
  const assets = p.assets || [p.asset];
  const receiptFilenameMatches = filename => typeof filename === 'string' && (p.asset.mimeType === 'image/jpeg'
    ? /^[A-Za-z0-9]+\.jpe?g$/i.test(filename) : /^[A-Za-z0-9]+\.png$/i.test(filename));
  if (p.store.allowDModels !== true && assets.some(a => /^D/i.test(a.model?.normalize('NFKC').trim() || ''))) fail('d_model_forbidden_in_new_old_store');
  const bankOrigin = 'https://photobank.alibaba.com';
  const identity = async () => {
    const r = await fetch('https://i.alibaba.com/ajax/sellerProfileAjax.do', { credentials: 'include', cache: 'no-store' });
    if (!r.ok) fail('identity_http_error');
    const d = await r.json();
    if (d.adminAliId !== p.store.aliId || d.adminMbrSeq !== p.store.memberSeq || d.minisite !== p.store.minisite) fail('seller_identity_mismatch');
    return { adminAliId: d.adminAliId, adminMbrSeq: d.adminMbrSeq, minisite: d.minisite };
  };
  const bankUrl = (groupId, page) => bankOrigin + '/fetch/bank?action=default&page=' + page + '&pageSize=' + p.pageSize + '&imageWidth=350&imageHeight=350&search=' + encodeURIComponent(JSON.stringify({ groupId }));
  const scan = async groupId => {
    let total, items = [], seen = new Set();
    for (let next = 1; next <= p.maxPages;) {
      const pages = total === undefined ? [1] : Array.from({ length: Math.min(3, Math.ceil(total / p.pageSize) - next + 1) }, (_, i) => next + i);
      const results = await Promise.allSettled(pages.map(async page => {
        const r = await fetch(bankUrl(groupId, page), { credentials: 'include', cache: 'no-store' });
        const d = await r.json();
        if (!r.ok || !d.success || !Number.isSafeInteger(d.data?.total) || d.data.total < 0 || d.data.currentPage !== page) fail('bank_query_failed');
        return d;
      }));
      for (let i = 0; i < results.length; i++) {
        if (results[i].status !== 'fulfilled') fail('bank_query_failed');
        const d = results[i].value, page = pages[i];
        if (total === undefined) total = d.data.total;
        if (total !== d.data.total) fail('pagination_total_changed');
        if (Math.ceil(total / p.pageSize) > p.maxPages) fail('dedupe_page_budget_exceeded');
        const list = d.data.list ?? [];
        if (!Array.isArray(list) || list.length !== Math.min(p.pageSize, Math.max(0, total - (page - 1) * p.pageSize))) fail('incomplete_bank_page');
        for (const item of list) {
          // The authenticated whole-bank response includes historical memberSeq values.
          // Keep them in dedupe; freshly uploaded target records still require the bound owner.
          if (!Number.isSafeInteger(item.id) || seen.has(item.id) || !Number.isSafeInteger(item.memberSeq) || (String(groupId) !== '-1' && item.memberSeq !== p.store.memberSeq)) fail('invalid_bank_identity_or_pagination');
          if (String(groupId) !== '-1' && String(item.groupId) !== String(groupId)) fail('bank_group_mismatch');
          seen.add(item.id);
          // Only matching records cross the browser boundary.
          if (p.full || assets.some(a => item.photobankImageMetadata?.hashCode === a.md5 || item.displayName === a.displayName)) items.push(item);
        }
        if (page * p.pageSize >= total) return { total, items, pages: page };
      }
      next = pages.at(-1) + 1;
    }
    fail('dedupe_page_budget_exceeded');
  };
  const ns = '__codexPhotobankUploadsV1';
  const state = () => window[ns]?.[p.key];
  const snapshot = s => {
    if (!s) return null;
    const { chunks, ...rest } = s;
    return { ...rest, chunkCount: chunks?.length ?? 0 };
  };
  const canAdd = jobs => {
    const others = Object.keys(jobs).filter(k => k !== p.key);
    if (others.some(k => !p.batchId || jobs[k].batchId !== p.batchId || jobs[k].storeId !== p.store.id)) fail('another_browser_upload_pending');
    if (others.length >= Math.min(9, p.batchSize || 1)) fail('browser_batch_capacity_exceeded');
  };
  const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
  if (['probe', 'catalog_page', 'preflight', 'lookup'].includes(p.op)) {
    const before = await identity();
    const r = await fetch(bankOrigin + '/fetch/groups/-1', { credentials: 'include', cache: 'no-store' });
    const groups = await r.json();
    const found = Array.isArray(groups.data) && groups.data.filter(g => g.id === p.store.groupId);
    if (!r.ok || !groups.success || !found || found.length !== 1 || found[0].name !== p.store.groupName || found[0].aliMemberId !== p.store.memberSeq) fail('target_group_mismatch');
    if (p.op === 'preflight') return { before, after: await identity() };
    let result;
    if (p.op === 'catalog_page') {
      if (!Number.isInteger(p.page) || p.page < 1 || p.page > p.maxPages) fail('invalid_catalog_page');
      const r = await fetch(bankUrl('-1', p.page), { credentials: 'include', cache: 'no-store' });
      const d = await r.json(), list = d.data?.list;
      if (!r.ok || !d.success || !Number.isSafeInteger(d.data?.total) || d.data.total < 0 || d.data.currentPage !== p.page || !Array.isArray(list)
        || list.length !== Math.min(p.pageSize, Math.max(0, d.data.total - (p.page - 1) * p.pageSize))) fail('incomplete_bank_page');
      if (Math.ceil(d.data.total / p.pageSize) > p.maxPages) fail('dedupe_page_budget_exceeded');
      if (list.some(x => !Number.isSafeInteger(x.id) || !Number.isSafeInteger(x.memberSeq)) || new Set(list.map(x => x.id)).size !== list.length) fail('invalid_bank_identity_or_pagination');
      result = { total: d.data.total, page: p.page, items: list.map(x => ({ id: x.id, memberSeq: x.memberSeq, groupId: x.groupId, displayName: x.displayName,
        filename: x.filename, imageUrl: x.imageUrl, gmtCreate: x.gmtCreate, photobankImageMetadata: x.photobankImageMetadata })) };
    } else {
      result = await scan(p.op === 'lookup' ? p.store.groupId : p.global ? '-1' : p.store.groupId);
      if (p.op === 'lookup') result.items = result.items.filter(item => assets.some(a => item.displayName === a.displayName
        && item.photobankImageMetadata?.hashCode === a.md5));
    }
    const after = await identity();
    return { before, after, ...result };
  }
  if (p.op === 'status') return snapshot(state());
  if (p.op === 'pending') {
    await identity();
    return Object.entries(window[ns] || {}).map(([key, value]) => ({ key, ...snapshot(value) }));
  }
  if (p.op === 'init') {
    await identity();
    const jobs = window[ns] ||= {};
    canAdd(jobs);
    if (jobs[p.key] && jobs[p.key].phase !== 'prepared') fail('browser_reconcile_required');
    jobs[p.key] = { phase: 'prepared', sha256: p.asset.sha256, batchId: p.batchId ?? null, storeId: p.store.id, chunks: [], createdAt: new Date().toISOString() };
    return snapshot(jobs[p.key]);
  }
  if (p.op === 'chunk') {
    const s = state();
    if (s?.phase !== 'prepared' || s.sha256 !== p.asset.sha256 || p.index !== s.chunks.length || typeof p.chunk !== 'string' || p.chunk.length > 65536) fail('invalid_chunk');
    s.chunks.push(p.chunk);
    return { index: p.index, length: p.chunk.length };
  }
  if (p.op === 'restore') {
    await identity();
    const jobs = window[ns] ||= {};
    canAdd(jobs);
    if (jobs[p.key]) fail('browser_reconcile_required');
    const u = p.upload;
    if (u?.code !== 0 || u.hash !== p.asset.md5 || u.size !== p.asset.bytes || u.width !== p.asset.width || u.height !== p.asset.height || !receiptFilenameMatches(u.filename)) fail('invalid_upload_receipt');
    const url = new URL(u.url);
    if (url.protocol !== 'https:' || url.hostname !== 'sc01.alicdn.com') fail('invalid_upload_url');
    jobs[p.key] = { phase: 'file_uploaded', sha256: p.asset.sha256, batchId: p.batchId ?? null, storeId: p.store.id, upload: u };
    return snapshot(jobs[p.key]);
  }
  if (p.op === 'upload') {
    const s = state();
    if (s?.phase !== 'prepared' || s.sha256 !== p.asset.sha256) fail('upload_reconcile_required');
    s.phase = 'file_preparing';
    try {
      const before = await identity();
      const bytes = Uint8Array.from(atob(s.chunks.join('')), c => c.charCodeAt(0));
      if (bytes.length !== p.asset.bytes || await digest(bytes) !== p.asset.sha256) fail('browser_bytes_mismatch');
      if (typeof window.AWSC?.configFY !== 'function') fail('platform_sdk_unavailable');
      const fy = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('platform_sdk_timeout')), 10000);
        window.AWSC.configFY(x => { clearTimeout(timer); resolve(x); }, { appName: 'global-filebroker-upstream-s' });
      });
      const form = new FormData();
      if (!['image/png', 'image/jpeg'].includes(p.asset.mimeType)) fail('invalid_asset_mime');
      form.append('file', new File([bytes], p.asset.filename, { type: p.asset.mimeType }));
      form.append('bizCode', 'icbu_photobank');
      const headers = fy ? { ua: fy.getUA(), umidtoken: fy.umidToken } : {};
      await identity();
      s.phase = 'file_post_started';
      s.uploadStartedAt = new Date().toISOString();
      const r = await fetch('https://filebroker.alibaba.com/x/upload', { method: 'POST', credentials: 'include', headers, body: form });
      const u = await r.json();
      s.uploadCompletedAt = new Date().toISOString();
      s.uploadHttpStatus = r.status;
      if (!r.ok || u.code !== 0 || u.hash !== p.asset.md5 || u.size !== p.asset.bytes || u.width !== p.asset.width || u.height !== p.asset.height || !receiptFilenameMatches(u.filename)) fail('upload_response_mismatch');
      s.upload = { code: u.code, filename: u.filename, url: u.url, hash: u.hash, size: u.size, width: u.width, height: u.height };
      s.phase = 'file_uploaded';
      s.identityBefore = before;
      s.identityAfter = await identity();
      delete s.chunks;
      return snapshot(s);
    } catch (e) {
      // No URL, cookie, token, or SDK header is returned in an error.
      s.error = 'file_upload_failed_or_uncertain';
      throw new Error(s.error);
    }
  }
  if (p.op === 'register') {
    const s = state();
    if (s?.phase !== 'file_uploaded' || s.registerAttempted || s.sha256 !== p.asset.sha256) fail('registration_reconcile_required');
    await identity();
    const u = s.upload;
    const body = {
      groupId: String(p.store.groupId), useWatermark: false,
      photobankImageWatermark: { frame: 'N', position: 'center', watermarkContent: '' },
      imgListData: [{ filename: u.filename, groupId: String(p.store.groupId), fileMd5: u.hash, displayName: p.asset.filename, photobankImageMetadata: { size: u.size, width: u.width, height: u.height, hashCode: u.hash }, photoUrl: u.url }]
    };
    // Same session-validation fields as the platform uploader; stay in this browser.
    const cookie = document.cookie;
    const xm = cookie.match(/(?:^|;)\s*xman_us_t\s*=\s*([^;]+)/)?.[1];
    const ct = window._intl_csrf_token_ || xm?.match(/(?:^|&)\s*ctoken\s*=\s*([^&]+)/)?.[1] || document.getElementsByName('_csrf_token')[0]?.value;
    const tb = cookie.match(/(?:^|;)\s*_tb_token_\s*=\s*([^;]+)/)?.[1];
    const url = new URL('/fetch/bank/photo/upload', bankOrigin);
    if (ct) url.searchParams.set('ctoken', ct);
    if (tb) url.searchParams.set('_tb_token_', tb);
    s.registerAttempted = true;
    s.phase = 'register_post_started';
    s.registerStartedAt = new Date().toISOString();
    try {
      const r = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'x-requested-with': 'XMLHttpRequest' }, body: JSON.stringify(body) });
      const d = await r.json();
      s.registerCompletedAt = new Date().toISOString();
      s.registerHttpStatus = r.status;
      s.registerResult = { code: d.code, success: d.success, errorCode: d.errorCode, duplicateCount: d.data?.duplicateList?.length ?? 0 };
      if (s.registerResult.duplicateCount) fail('registration_duplicate_reconcile_required');
      if (!r.ok || !d.success || d.code !== 200) fail('registration_rejected');
      s.phase = 'registered';
      s.identityAfter = await identity();
      return snapshot(s);
    } catch (e) {
      s.error = e.message === 'registration_duplicate_reconcile_required' ? e.message : 'registration_failed_or_uncertain';
      throw new Error(s.error);
    }
  }
  if (p.op === 'verify') {
    const before = await identity();
    const item = p.item, m = item.photobankImageMetadata;
    if (!Number.isSafeInteger(item.id) || item.memberSeq !== p.store.memberSeq || item.groupId !== p.store.groupId || m?.hashCode !== p.asset.md5 || m.size !== p.asset.bytes || m.width !== p.asset.width || m.height !== p.asset.height) fail('readback_mismatch');
    const url = new URL(item.imageUrl, bankOrigin);
    if (url.protocol !== 'https:' || !/^sc\d+\.alicdn\.com$/.test(url.hostname) || !url.pathname.startsWith('/kf/')) fail('invalid_cdn_url');
    const r = await fetch(url, { credentials: 'omit', cache: 'no-store' });
    if (!r.ok) fail('cdn_http_error');
    const bytes = await r.arrayBuffer();
    if (bytes.byteLength !== p.asset.bytes || await digest(bytes) !== p.asset.sha256) fail('cdn_bytes_mismatch');
    return { before, after: await identity(), verifiedAt: new Date().toISOString(), item, cdn: { url: url.href, status: r.status, bytes: bytes.byteLength, sha256: p.asset.sha256 } };
  }
  if (p.op === 'cleanup') {
    delete window[ns]?.[p.key];
    if (window[ns] && !Object.keys(window[ns]).length) delete window[ns];
    return { cleaned: true };
  }
  fail('unknown_operation');
}
