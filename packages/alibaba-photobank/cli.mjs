import { parseArgs } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareAsset, resolveImage, DEFAULT_STATE_DIR, STORES, DADB } from './index.mjs';
import { resolveListingImages } from './listing-images.mjs';

const { positionals, values: v } = parseArgs({ allowPositionals: true, options: Object.fromEntries(['index','asset','sha256','model','variant','shop','state-dir','template','count'].map(k => [k, { type: 'string' }])) });
try {
  let result;
  switch (positionals[0]) {
    case 'listing-images':
      result = await resolveListingImages({ shopId: v.shop, model: v.model, variant: v.variant, template: v.template, count: v.count === undefined ? undefined : Number(v.count), stateDir: v['state-dir'] });
      break;
    case 'prepare': {
      const p = await prepareAsset({ indexPath: v.index, relativePath: v.asset });
      result = { source_index: p.sourceIndex, source_selector: p.relativePath, model: p.entry.model, variant: p.entry.variant, approval: p.entry.user_approval, ...p.asset };
      break;
    }
    case 'resolve':
      result = await resolveImage({ sha256: v.sha256, model: v.model, variant: v.variant, shopId: v.shop || DADB.id, stateDir: v['state-dir'] });
      break;
    case 'inspect': {
      if (!/^[a-f0-9]{64}$/.test(v.sha256)) throw Error('sha256_required');
      if (!Object.hasOwn(STORES, v.shop || DADB.id)) throw Error('unknown_store');
      const root = path.join(path.resolve(v['state-dir'] || DEFAULT_STATE_DIR), v.shop || DADB.id);
      result = {};
      for (const [key, dir] of [['job','jobs'], ['mapping','mappings']]) {
        try { result[key] = JSON.parse(await fs.readFile(path.join(root, dir, v.sha256 + '.json'), 'utf8')); }
        catch (e) { if (e.code === 'ENOENT') result[key] = null; else throw e; }
      }
      break;
    }
    default:
      result = { usage: ['node cli.mjs prepare --index <approved-index.json> --asset <relative_path>', 'node cli.mjs resolve --shop <store> --sha256 <hash> --model <model> --variant <variant>', 'node cli.mjs listing-images --shop <store> --model <model> --variant <variant> --template T01', 'node cli.mjs inspect --shop <store> --sha256 <hash>'], upload: 'Run connectBuiltinChromeStores(...).uploadApproved(...) inside the Codex cua_repl session. This CLI does not control Chrome.' };
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (e) {
  process.stderr.write(JSON.stringify({ ok: false, code: e.code || e.message }) + '\n');
  process.exitCode = 1;
}
