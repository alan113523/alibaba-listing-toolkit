import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, loadPlan, matchesOnline, readArgs, tools, writeSteps } from './plan.mjs';

const twoHours = 2 * 60 * 60 * 1000;
const statusesReadyToWrite = new Set(['not-started', 'partially-edited']);
const timestamp = () => new Date().toISOString();

function read(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function record(filename, value) {
  fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
}

function replace(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    record(temporary, value);
    fs.renameSync(temporary, filename);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function withLock(dir, action) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, 'batch.lock');
  try {
    record(lock, { pid: process.pid, startedAt: timestamp() });
  } catch (error) {
    if (error.code === 'EEXIST') throw Error('BATCH_LOCKED');
    throw error;
  }
  try {
    return await action();
  } finally {
    fs.unlinkSync(lock);
  }
}

function ownerFile(dir, sellerId, productId) {
  const root = path.join(path.dirname(fs.realpathSync(dir)), '.bulk-edit-owners');
  return path.join(root, `${digest(JSON.stringify([sellerId, productId]))}.json`);
}

function claimProduct(filename, batchId) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    record(filename, { batchId, claimedAt: timestamp() });
    return 'created';
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Another writer may have just created the file and still be flushing it.
    try { return read(filename)?.batchId === batchId ? 'owned' : 'occupied'; }
    catch (readError) { if (readError instanceof SyntaxError) return 'occupied'; throw readError; }
  }
}

function reserveProducts(dir, plan, batchId, products) {
  const filenames = products.map(product => ownerFile(dir, plan.stores[product.store], product.id)).sort();
  const created = [];
  let reserved = false;
  try {
    for (const filename of filenames) {
      const result = claimProduct(filename, batchId);
      if (result === 'occupied') return false;
      if (result === 'created') created.push(filename);
    }
    reserved = true;
    return true;
  } finally {
    if (!reserved) for (const filename of created) fs.unlinkSync(filename);
  }
}

function releaseOwners(dir, plan, batchId, report, releaseUnstarted = false) {
  for (const row of report.products) {
    if (row.status !== 'verified' && !(releaseUnstarted && row.status === 'not-started')) continue;
    const filename = ownerFile(dir, plan.stores[row.store], row.productId);
    let owner;
    try { owner = read(filename); }
    catch (error) { if (error instanceof SyntaxError) continue; throw error; }
    if (owner?.batchId === batchId) fs.unlinkSync(filename);
  }
  return report;
}

function fingerprint(plan, product, step, args) {
  return digest(JSON.stringify([plan.sha256, product.store, product.id, tools[step], args]));
}

function productState(plan, dir, product) {
  const directory = path.join(dir, 'products', `store-${product.store}`, String(product.id));
  let result = { status: 'not-started', directory };
  let blocked = false;
  for (const [step, args] of writeSteps(product)) {
    const prefix = path.join(directory, step);
    const intent = read(`${prefix}.intent.json`);
    const receipt = read(`${prefix}.receipt.json`);
    if (intent === undefined && receipt === undefined) {
      blocked = true;
      continue;
    }
    if (blocked || !intent?.callId || intent.requestSha256 !== fingerprint(plan, product, step, args) ||
        (receipt !== undefined && (receipt?.callId !== intent.callId ||
         !['accepted', 'rejected', 'unknown'].includes(receipt.outcome)))) throw Error('INVALID_WRITE_JOURNAL');

    const outcome = receipt?.outcome ?? 'unknown';
    result = { directory, callId: intent.callId, step, status: 'unknown-write' };
    if (outcome === 'accepted') {
      result.status = step === 'submit' ? 'pending-verification' : 'partially-edited';
    } else {
      if (outcome === 'rejected') result.status = 'rejected';
      blocked = true;
    }
  }

  const observed = read(path.join(directory, 'verification.json'));
  const schedule = observed && scheduleAt(dir, plan);
  if (schedule && observed.writeCallId === result.callId && result.callId && observed.callId &&
      typeof observed.fieldsMatch === 'boolean' && observed.verifyNotBefore === schedule.verifyNotBefore &&
      Date.parse(observed.checkedAt) >= Date.parse(schedule.verifyNotBefore) &&
      JSON.stringify(observed.components) === JSON.stringify(readArgs(product).componentList)) {
    result.lastReadback = observed;
    if (result.status === 'pending-verification' && observed.fieldsMatch) result.status = 'verified';
  }
  return result;
}

function binding(dir, plan, create = false) {
  const filename = path.join(dir, 'batch.json');
  const bound = read(filename);
  if (bound === undefined) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).some(name => name !== 'batch.lock')) {
      throw Error('UNBOUND_RUN_DIRECTORY');
    }
    if (!create) return null;
    const fresh = { version: 1, batchId: randomUUID(), scopeSha256: plan.sha256, createdAt: timestamp() };
    record(filename, fresh);
    return fresh;
  }
  if (bound?.version !== 1 || !bound.batchId || bound.scopeSha256 !== plan.sha256) throw Error('SCOPE_CHANGED');
  return bound;
}

function scheduleAt(dir, plan) {
  const schedule = read(path.join(dir, 'verification-window.json'));
  if (schedule === undefined) return null;
  if (schedule?.scopeSha256 !== plan.sha256 ||
      Date.parse(schedule.verifyNotBefore) - Date.parse(schedule.submissionRoundEndedAt) !== twoHours) {
    throw Error('INVALID_VERIFICATION_WINDOW');
  }
  return schedule;
}

function summary(dir, plan, stopped = null) {
  const schedule = scheduleAt(dir, plan);
  const rows = plan.products.map(product => {
    const { status, step, lastReadback } = productState(plan, dir, product);
    return { store: product.store, productId: product.id, status, step, lastReadback };
  });
  const counts = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  return { scopeSha256: plan.sha256, counts, schedule, stopped, products: rows };
}

function validateTransport(transport) {
  if (typeof transport?.getSellerId !== 'function' || typeof transport?.invoke !== 'function') {
    throw Error('TRANSPORT_REQUIRED');
  }
}

async function identify(transport, store, sellerId) {
  try {
    return await transport.getSellerId(store) === sellerId ? null : 'SELLER_IDENTITY_MISMATCH';
  } catch {
    return 'SELLER_IDENTITY_UNAVAILABLE';
  }
}

async function invoke(transport, { store, sellerId, step, args, callId }) {
  let body;
  try {
    body = await transport.invoke({ store, sellerId, tool: tools[step], args: structuredClone(args), callId });
  } catch {
    return { failure: 'TRANSPORT_FAILURE' };
  }
  const failure = await identify(transport, store, sellerId);
  return { body, failure };
}

function writeOutcome(step, body) {
  const expected = step === 'submit' ? 'submit draft success' : 'draft edit success';
  if (body?.success === true && body.data === expected) return 'accepted';
  if (body?.success === false || body?.data === 'Attribute value cannot be blank.') return 'rejected';
  return 'unknown';
}

async function writeProduct(transport, plan, dir, product) {
  const { status, directory, step: lastStep } = productState(plan, dir, product);
  if (!statusesReadyToWrite.has(status)) return null;
  const { store } = product;
  const sellerId = plan.stores[store];
  const steps = writeSteps(product);
  const start = steps.findIndex(([step]) => step === lastStep) + 1;
  for (const [step, args] of steps.slice(start)) {
    const before = await identify(transport, store, sellerId);
    if (before) return before;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const callId = randomUUID();
    const prefix = path.join(directory, step);
    record(`${prefix}.intent.json`, { callId, requestSha256: fingerprint(plan, product, step, args), startedAt: timestamp() });
    const { body, failure } = await invoke(transport, { store, sellerId, step, args, callId });
    const outcome = failure ? 'unknown' : writeOutcome(step, body);
    record(`${prefix}.receipt.json`, { callId, outcome, finishedAt: timestamp() });
    if (outcome !== 'accepted') return failure;
  }
  return null;
}

async function verifyProduct(transport, plan, dir, product, schedule) {
  const prior = productState(plan, dir, product);
  if (!['pending-verification', 'unknown-write'].includes(prior.status)) return null;
  const { store } = product;
  const sellerId = plan.stores[store];
  const before = await identify(transport, store, sellerId);
  if (before) return before;
  const callId = randomUUID();
  const args = readArgs(product);
  const { body, failure } = await invoke(transport, { store, sellerId, step: 'query', args, callId });
  if (failure) return failure;
  let value = body?.data;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  replace(path.join(prior.directory, 'verification.json'), {
    callId,
    writeCallId: prior.callId,
    checkedAt: timestamp(),
    verifyNotBefore: schedule.verifyNotBefore,
    components: args.componentList,
    fieldsMatch: body?.success === true && matchesOnline(product, value)
  });
  return null;
}

function workerLimits({ concurrencyPerStore = 2, maxConcurrent = 6 }) {
  if (!Number.isInteger(concurrencyPerStore) || concurrencyPerStore < 1 || concurrencyPerStore > 12 ||
      !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 36) {
    throw Error('INVALID_CONCURRENCY');
  }
  return { concurrencyPerStore, maxConcurrent };
}

async function runQueue(dir, products, { concurrencyPerStore, maxConcurrent }, processProduct) {
  const groups = Map.groupBy(products, product => product.store);
  const queues = Array.from(groups.values(), rows => ({ rows, next: 0, active: 0 }));
  let stopped = null;
  let fatal;
  async function worker() {
    while (!stopped) {
      if (fs.existsSync(path.join(dir, 'drain-request.json'))) {
        stopped = 'DRAIN_REQUESTED';
        break;
      }
      const queue = queues.find(entry => entry.next < entry.rows.length && entry.active < concurrencyPerStore);
      if (!queue) return;
      const product = queue.rows[queue.next++];
      queue.active++;
      try {
        const failure = await processProduct(product);
        stopped ??= failure;
      } catch (error) {
        fatal ??= error;
        stopped = 'LOCAL_JOURNAL_FAILURE';
      } finally {
        queue.active--;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxConcurrent, products.length) }, worker));
  if (fatal) throw fatal;
  return stopped;
}

export const preview = ({ scopePath }) => loadPlan(scopePath);

export function status({ scopePath, runDir }) {
  const plan = loadPlan(scopePath);
  binding(runDir, plan);
  return summary(runDir, plan);
}

export async function apply({ scopePath, runDir, approvedSha256, transport, ...limits }) {
  const plan = loadPlan(scopePath);
  if (approvedSha256 !== plan.sha256) throw Error('SCOPE_APPROVAL_MISMATCH');
  validateTransport(transport);
  const concurrency = workerLimits(limits);
  return withLock(runDir, async () => {
    const { batchId } = binding(runDir, plan, true);
    if (scheduleAt(runDir, plan)) return releaseOwners(runDir, plan, batchId, summary(runDir, plan));
    const eligible = plan.products.filter(product => statusesReadyToWrite.has(productState(plan, runDir, product).status));
    if (!reserveProducts(runDir, plan, batchId, eligible)) {
      return summary(runDir, plan, 'PRODUCT_OWNED_BY_ANOTHER_BATCH');
    }
    const stopped = await runQueue(runDir, eligible, concurrency,
      product => writeProduct(transport, plan, runDir, product));
    const report = summary(runDir, plan, stopped);
    if (!report.counts['not-started'] && !report.counts['partially-edited']) {
      const ended = Date.now();
      const schedule = {
        scopeSha256: plan.sha256,
        submissionRoundEndedAt: new Date(ended).toISOString(),
        verifyNotBefore: new Date(ended + twoHours).toISOString()
      };
      record(path.join(runDir, 'verification-window.json'), schedule);
      report.schedule = schedule;
    }
    return releaseOwners(runDir, plan, batchId, report, true);
  });
}

export async function reconcile({ scopePath, runDir, transport, ...limits }) {
  const plan = loadPlan(scopePath);
  validateTransport(transport);
  const concurrency = workerLimits(limits);
  return withLock(runDir, async () => {
    const batch = binding(runDir, plan);
    if (!batch) throw Error('BATCH_NOT_STARTED');
    const schedule = scheduleAt(runDir, plan);
    if (!schedule) throw Error('SUBMISSION_ROUND_INCOMPLETE');
    if (Date.now() < Date.parse(schedule.verifyNotBefore)) throw Error('VERIFICATION_NOT_DUE');
    const eligible = plan.products.filter(product => ['pending-verification', 'unknown-write']
      .includes(productState(plan, runDir, product).status));
    const stopped = await runQueue(runDir, eligible, concurrency,
      product => verifyProduct(transport, plan, runDir, product, schedule));
    return releaseOwners(runDir, plan, batch.batchId, summary(runDir, plan, stopped));
  });
}
