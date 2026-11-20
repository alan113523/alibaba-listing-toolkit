# Bulk edit existing products

The batch runner changes specified fields on existing Alibaba.com listings. Each product follows the sequence of attribute edits, trade edits, optional sample disablement and one submission. The run records each write intent before calling the adapter. Two hours after the submission round ends, reconciliation queries the official product version and compares the requested fields.

## Try the offline example

With Node.js 22 or newer, run these commands from the repository. Copy the `sha256` value printed by `plan` into the second command in place of `APPROVED_SHA256`.

```sh
npm run bulk-edit -- plan packages/alibaba-bulk-edit/scope.example.json
npm run bulk-edit -- apply packages/alibaba-bulk-edit/scope.example.json .local/bulk-demo packages/alibaba-bulk-edit/demo-transport.mjs APPROVED_SHA256
npm run bulk-edit -- status packages/alibaba-bulk-edit/scope.example.json .local/bulk-demo
```

The demo uses three invented products and a local transport that simulates responses. The output includes `verifyNotBefore`. At that time, run the following command with the same scope and directory. `npm test` covers the full cycle immediately using a simulated clock.

```sh
npm run bulk-edit -- reconcile packages/alibaba-bulk-edit/scope.example.json .local/bulk-demo packages/alibaba-bulk-edit/demo-transport.mjs
```

## Freeze a scope

Copy [the synthetic scope](../packages/alibaba-bulk-edit/scope.example.json) into an ignored local location such as `.local/scope.json`. Replace its contents with the reviewed seller bindings, product IDs and target values for your batch. Store aliases use lowercase letters, digits and hyphens. Each alias maps to a distinct seller ID string. Product IDs are positive JSON integers representable exactly by JavaScript.

| Field | Supported changes |
| --- | --- |
| `attributes` | `ADD` or `EDIT` for category attributes. Set `attrNameId`, `attrName`, `attrValue` and, when applicable, `attrValueId`. |
| `trade` | `saleType: "normal"`, `moq`, and/or a full target `ladderPrices` array. The ladder uses `ADD` or `EDIT`, zero-based indexes, quantity bounds and positive decimal price strings. Only the last tier may omit the upper bound. Confirm the currency and tier semantics in your seller client. |
| `sample` | Set to `false` to disable the sample option. Omit this field to leave sample settings alone. |

`plan` shows the parsed scope and hashes the exact file bytes. Review the target fields and pass the displayed digest to `apply`. Any change to those bytes requires a fresh review, and an existing run directory stays bound to its original digest.

## Connect an authorized seller client

Place a local ES module under an ignored directory and export a transport as its default export. The CLI loads that module for `apply` and `reconcile`. The [synthetic transport](../packages/alibaba-bulk-edit/demo-transport.mjs) shows the calling convention. Use a seller client with access to all the operations your scope requires. The Alibaba.com Open Platform is an entry point to check app access and API documentation. [Alibaba.com Open Platform](https://openapi.alibaba.com/)

| Transport method | Contract |
| --- | --- |
| `getSellerId(store)` | Return the actual seller ID string from the active authorization assigned to `store`. The runner compares it with the separate value in the reviewed scope before and after each call. |
| `invoke({ store, sellerId, tool, args, callId })` | Use a session bound to `sellerId` at dispatch, including when multiple stores run concurrently. Dispatch each write once with client retries disabled. Treat `callId` as local correlation metadata. Throw for transport, authorization, rate-limit or uncertain execution failures. |

The runner passes the operation names `product_edit_draft_basic_info`, `product_edit_draft_trade`, `product_edit_draft_sample`, `product_submit_draft` and `product_query_information`. Map them to the operations granted to your client and validate the current interface before live use. `args` contains the product ID and the corresponding field patch. For readback, `args` also contains `queryType: "trunk"` and `componentList` for the changed fields.

Normalize edit acknowledgments to `{ success: true, data: "draft edit success" }` and accepted submissions to `{ success: true, data: "submit draft success" }`. Return `{ success: false }` for a definitive business rejection. Normalize official-version data to `{ success: true, data }`, with the returned `productId` and the applicable `basicInfo.attr`, `trade` or `sample.supportSample` fields. Use numeric attribute IDs, quantities and ladder indexes. Represent an open-ended tier with an omitted or `null` upper bound. The adapter is responsible for distinguishing acceptance from transport success and for verifying that the returned record is the official product version.

The CLI uses two workers per store and six across all stores. Import `apply` and `reconcile` from [`batch.mjs`](../packages/alibaba-bulk-edit/batch.mjs) to pass `concurrencyPerStore` and `maxConcurrent` within limits of 12 and 36. `preview({ scopePath })` and `status({ scopePath, runDir })` need no seller client.

## Resume and reconcile

- Keep all run directories as immediate siblings under one local workspace, such as `.local/bulk-runs/`. A run lock coordinates processes within a batch. Before writing, the runner reserves the eligible seller and product IDs in the shared `.bulk-edit-owners/` directory. A conflict stops the attempt before any seller write. Successful verification releases the reservation. Use the same workspace for all writers on those products.
- Add `drain-request.json` to a running batch directory to stop workers from taking new products. In-flight products finish their current sequence. After the process exits, remove the drain request and run `apply` again with the original digest. A lock left by an interrupted process requires checking its recorded PID before clearing it.
- Run `reconcile` at or after `verifyNotBefore`. It queries fields read-only and can be rerun for pending products. `pending-verification` records an accepted submission. `verified` requires an accepted submission and matching fields on the intended product. `unknown-write` retains the uncertain outcome even if a later read returns the target values. `rejected` records a definitive rejection. Both retain the shared reservation. Check the platform draft and submission state before clearing the reservation manually, and preserve the batch journal.
- Keep the scope, transport, logs and run directory local. The journal records digests, operation IDs, receipts and comparison results. The `plan` and `status` outputs include the scope or product identifiers, respectively.
