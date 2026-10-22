# Contributing

Use Node.js 22+ and run `npm run check` and `npm test`. The suite provisions its own temporary synthetic workspace; do not provide real seller credentials or production assets.

Keep changes focused. Preserve public adapter names, explicit identity checks, protected-field comparison, durable intent, per-store locking and reconciliation rules.
When a protocol change is needed, include the redacted contract change and a synthetic regression. Never use an issue or pull request to upload cookies, local bindings, seller payloads or real receipts.

SAFE_FILES.txt is the reviewed source allowlist. Add a new source file there and update .gitignore explicitly; new files are otherwise ignored. Review the staged tree before every commit and scan it for credentials.

A test result is local evidence. Do not describe mocked operations as successful platform saves, uploads or publication. Describe any separate authorized live validation with its actual scope, without publishing business records.

Contributions are licensed under the repository's MIT license. Preserve notices if introducing external code and explain any added dependency.
