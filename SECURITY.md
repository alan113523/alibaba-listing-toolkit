# Security and private data

Do not open public reports containing seller bindings, authentication values, customer information, image originals, native payloads or write receipts.
Use GitHub private vulnerability reporting when available. A public report should contain only a minimal synthetic reproduction and redacted error codes.

Real bindings belong in each package's ignored .local directory. Missing or invalid bindings stop execution. Never replace these checks with sample accounts or disable identity validation to make a test pass.

Keep original unknown-outcome records for reconciliation. Deleting intent files can permit duplicate business writes and is not a recovery method.
