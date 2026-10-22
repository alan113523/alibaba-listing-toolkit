import fs from 'node:fs/promises';
import path from 'node:path';
import { assertStoreModel, prepareAsset, resolveImage, DEFAULT_STATE_DIR } from './index.mjs';

// Local verified mappings are the source of image references. This function
// never opens a browser, scans the bank, uploads, or advances a template cursor.
export async function resolveListingImages({ shopId, model, variant, template = 'T01', count = 6, stateDir = DEFAULT_STATE_DIR }) {
  assertStoreModel(shopId, model);
  if (!variant || !/^T0[123]$/.test(template) || !Number.isInteger(count) || count < 1 || count > 6) throw Error('variant_template_count_required');
  const dir = path.join(path.resolve(stateDir), shopId, 'mappings');
  const mappings = [];
  for (const name of await fs.readdir(dir)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const m = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
    if (m.shop_id === shopId && m.model === model && m.variant === variant && m.template === template) mappings.push(m);
  }
  const images = [];
  for (let n = 1; n <= count; n++) {
    const slot = 'MAIN' + String(n).padStart(2, '0');
    const matches = mappings.filter(m => m.slot === slot);
    if (matches.length !== 1) throw Error('mapping_slot_missing_or_ambiguous:' + slot);
    const m = matches[0];
    const verified = await resolveImage({ shopId, model, variant, sha256: m.image_hash, stateDir });
    const source = await prepareAsset({ indexPath: m.source_index, relativePath: m.source_selector });
    if (source.entry.template !== template || source.entry.slot !== slot) throw Error('mapping_template_slot_mismatch:' + slot);
    if (!m.ready_for_listing_image_reference || !m.platform_filename || m.width < 1 || m.height < 1) throw Error('mapping_not_ready:' + slot);
    images.push({ ...verified, template, slot, filename: m.platform_filename, displayName: path.basename(m.local_path), width: m.width, height: m.height, bytes: m.bytes });
  }
  if (new Set(images.map(i => i.platform_image_id)).size !== count || new Set(images.map(i => i.image_hash)).size !== count) throw Error('duplicate_listing_image');
  // Native onPhotobankSelected and scImages serializer fields, main-cgs 7.1.124.
  const list = images.map((i, n) => ({ fileFlag: 'add', fileId: i.platform_image_id, fileName: i.displayName,
    fileSavePath: i.filename, imgURL: i.image_url, fileURL: i.image_url, fileSrcOrder: 0, fileDestOrder: n + 1,
    isError: false, fileSize: i.bytes, fileHeight: i.height, fileWidth: i.width, fileMd5: i.platform_response_hash }));
  return { shop_id: shopId, model, variant, template, images, list, upload_count: 0, gallery_scan_count: 0 };
}
