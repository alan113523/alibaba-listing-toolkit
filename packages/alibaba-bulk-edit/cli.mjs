import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply, preview, reconcile, status } from './batch.mjs';

const usage = `Usage:
  node packages/alibaba-bulk-edit/cli.mjs plan <scope.json>
  node packages/alibaba-bulk-edit/cli.mjs status <scope.json> <run-directory>
  node packages/alibaba-bulk-edit/cli.mjs apply <scope.json> <run-directory> <transport.mjs> <approved-sha256>
  node packages/alibaba-bulk-edit/cli.mjs reconcile <scope.json> <run-directory> <transport.mjs>`;

async function main([command, ...args]) {
  if (!command || command === '--help') {
    console.log(usage);
    return;
  }

  const argCounts = new Map([['plan', 1], ['status', 2], ['apply', 4], ['reconcile', 3]]);
  if (argCounts.get(command) !== args.length) throw Error('INVALID_ARGUMENTS');
  const [scopePath, runDir, transportPath, approvedSha256] = args;
  const options = { scopePath, runDir };
  let report;
  if (command === 'plan') {
    report = preview(options);
  } else if (command === 'status') {
    report = status(options);
  } else {
    if (command === 'apply' && approvedSha256 !== preview(options).sha256) throw Error('SCOPE_APPROVAL_MISMATCH');
    const { default: transport } = await import(pathToFileURL(resolve(transportPath)).href);
    report = command === 'apply' ? await apply({ ...options, transport, approvedSha256 }) :
      await reconcile({ ...options, transport });
    if (report.stopped) process.exitCode = 2;
  }
  console.log(JSON.stringify(report, null, 2));
}

main(process.argv.slice(2)).catch(error => {
  const errorCode = /^[A-Z_]+$/.test(error?.message) ? error.message : 'LOCAL_OR_ADAPTER_ERROR';
  console.error(JSON.stringify({ error: errorCode }));
  process.exitCode = 1;
});
