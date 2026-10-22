# Listing workflow

1. **Freeze the task.** Record seller role, model, source product, quantity, approved copy/assets and whether the task permits reads, draft saves, uploads or final publication.
2. **Verify live identity.** Compare seller profile fields with the configured expectation. For multiple stores, check primary → secondary A → secondary B → primary, then verify the target again around each business operation.
3. **Validate inputs.** Check the real model/variant, SKU and commercial fields. Validate source hashes and exact approval evidence. A content approval does not authorize every platform operation.
4. **Prepare the request.** Preserve the reference product, freeze the intended differences, inspect the current native form and action, and retain the run's identifiers.
5. **Persist intent, then dispatch once.** A saved marker, successful tool call or HTTP200 alone does not prove a business operation succeeded.
6. **Read back and compare.** Verify the returned target ID, seller, protected fields and image order. Consume a mapping/rotation assignment only under the task's established successful-readback rule.
7. **Reconcile uncertainty.** Retain the original intent and response. Use bounded reads to find a uniquely matching result; do not delete locks, retry blindly, switch directories or create a replacement listing.
8. **Report the actual state.** Distinguish prepared, draft saved, fresh platform quality checked, submitted, under review, approved and displayed.

The public packages implement draft and photobank operations. Full master-field assembly, current platform quality review and final publication remain separate integration work; historical business launchers are not shipped.

Native page schemas and frontend validation can differ by category or step. A score does not substitute for complete submission validation. When adapting a protocol, validate the actual authorized first task and its readback before expanding a batch.

Store aliases, browser labels and local filenames never establish seller identity. Keep one writer for a product. Cancellation stops the corresponding work and must not be reversed by stale run instructions.
