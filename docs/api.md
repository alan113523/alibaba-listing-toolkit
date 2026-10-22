# API and host contract

## Browser capability

Live adapters receive an existing `cdp` object with an asynchronous `send(method, parameters, options)` method. They use Runtime.evaluate with a serialized browser task, `awaitPromise: true` and `returnByValue: true`.
Responses must expose the actual `result.value` or `exceptionDetails`; returning fabricated success values invalidates reconciliation.

The host owns seller login, page/profile selection and user authorization. Use an in-process capability supported by the host. These modules do not discover debug ports, launch Chrome or export session cookies.

## Local configuration

Each package reads its own `.local/store-bindings.json`. Real configuration is never tracked. Start from the package's `bindings.example.json`; fill all placeholders using independently verified values.

The photobank configuration names one primary store and three store records, each with its seller ID, member sequence, minisite and target group. The draft configuration keeps three seller/minisite bindings plus the legacy single-entry source and primary role.
The local loaders validate shapes, positive integer identifiers, distinct identities and matching minisites. Missing files and empty examples fail before business execution.

The maps are expected values, not identity evidence. Actual identity is checked through the authenticated seller profile endpoint. A primary role permits the existing D-prefix model family; secondary roles reject it.

## Draft package

| Export | Purpose |
| --- | --- |
| `createConcurrentDraftAdapter({ cdp, runDir, shop, sourceId, count, expectedModel })` | Frozen same-store batch, count 1 or 2 |
| `createSingleDraftAdapter({ cdp, runDir })` | Legacy single-entry scope from local bindings |
| `buildDraftBody(model, runId, scope)` | Native draft-body construction and protected-field checks |
| `createImageDraftAdapter({ cdp, runDir, sourceId, shopId, model, variant, template, stateDir, sourceChecks })` | Image mapping plus draft creation; explicit source required |
| `verifyBatch({ manifest, prepared, receipts, readback })` | Compare source integrity, identity and inherited business fields |

Batch methods are `prepare`, `preflight`, `saveOnce`, `readback` and `receipt`. Image adapters also preserve mapping assignments. Review actual return fields before advancing to the next operation.
`saveOnce` writes an exclusive intent before dispatch. A second call fails instead of repeating the write. On an uncertain transport outcome, retain all files and reconcile using the same identifiers.

Browser task functions are protocol internals. Serialized draft calls need an explicit scope; serialized image-body calls need the primary role argument. Use the public adapter factories to supply them consistently.

The optional PowerShell material entry depends on a separately installed, authorized host skill. It is retained for compatibility and is not part of the self-contained offline test setup.

## Photobank package

| Export | Purpose |
| --- | --- |
| `prepareAsset({ indexPath, relativePath })` | Validate source bytes, dimensions and exact approval evidence |
| `createUploader({ cdp, shopId, stateDir, ...options })` | Create an uploader for one configured seller |
| `connectBuiltinChrome` / `connectBuiltinChromeStores` | Bind through a host-provided built-in extension capability |
| `resolveImage({ sha256, model, variant, shopId, stateDir })` | Resolve a verified local reference |
| `resolveListingImages({ shopId, model, variant, template, count, stateDir })` | Resolve ordered main-image mappings without browser access |
| `adoptExistingDetail(...)` | Verify an existing detail image before adopting its local mapping |

Uploader operations include `uploadApproved`, `uploadBatch`, `uploadBatchSteps`, `inspectApproved`, `inspectBatch` and `inspectPending`. A same-store batch is limited to nine images and shares one store lock.
The default strategy reuses verified local mappings and relies on platform deduplication for new uploads. Full-gallery indexing is an explicit maintenance strategy, not an automatic fallback.

## Asset and state contracts

Main-image entries identify model, variant, template, MAIN slot, local path, source SHA-256 and hash-bound approval evidence. Authorized detail entries additionally carry detail role/order, source provenance and an exact-file upload authorization.
Generate these records from materials you are allowed to use; changing file bytes invalidates the approval hash. Inspect the source validation functions for the complete contract before integration.

`state/<store>/` retains jobs, mappings, locks and reconciliation evidence. State and run directories are local records, not sample data. Keep them for recovery and exclude them from source control.

## Verification boundaries

Offline tests demonstrate local protocol handling, isolation, locks, hashing and reconciliation behavior. They do not establish that current production endpoints accept requests, that a draft passed quality review or that a listing is displayed.
Protocol updates require a separate authorized validation using the current seller and page model.
