import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildDraftBody, createSingleDraftAdapter } from '../similar-draft.mjs';

import { syntheticModel } from './synthetic-model.mjs';
const fixture = async () => syntheticModel();

test('native similar-draft payload preserves protected copy content', async () => {
  const model = await fixture(), before = structuredClone(model);
  const result = buildDraftBody(model, 'local-current-run');
  assert.deepEqual(model, before);
  assert.equal(new URL(result.url).searchParams.get('pubType'), 'similarPost');
  assert.equal(result.fields.itemId, 401);
  assert.equal(result.fields.catId, model.models.global.catId);
  assert.equal(typeof result.fields.jsonBody, 'string');
  for (const key of ['productTitle', 'textDesc', 'scImages', 'detailImage', 'companyImage', 'companyFaqDesc']) assert.deepEqual(result.body[key], model.models.formValues[key]);
  assert.equal(result.body.sku.length, 8);
  assert.equal(result.body.superText, undefined);
});

test('scope mismatch and non-copy endpoint are rejected before write', async () => {
  for (const mutate of [m => m.models.global.id++, m => m.models.global.adminAliId++, m => m.models.global.pubType = null, m => m.models.global.currentPage = 1, m => m.components.draftBtn.props.action = 'submitDraft.json?pubType=edit']) {
    const model = await fixture(); mutate(model);
    assert.throws(() => buildDraftBody(model, 'run'));
  }
});

test('ambiguous save cannot be resent from this or a new adapter', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dadb-draft-once-'));
  let calls = 0;
  const cdp = { async send() { calls++; throw new Error('transport ended after dispatch'); } };
  const first = createSingleDraftAdapter({ cdp, runDir });
  await assert.rejects(first.saveOnce(), /unknown_reconcile/);
  await assert.rejects(first.saveOnce(), /EEXIST/);
  await assert.rejects(createSingleDraftAdapter({ cdp, runDir }).saveOnce(), /EEXIST/);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(runDir, 'save-unknown.json'))).status, 'reconcile_only');
});
