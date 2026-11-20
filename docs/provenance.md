# Release provenance

The public draft and photobank modules started from independently reviewed local source revisions. The public repository began with a clean Git history, with seller configuration and run data kept local.

| Source module | Reviewed source revision |
| --- | --- |
| alibaba-draft-interface | 6285d4120127a0e90c83d652dacec0e7aa0de672 |
| alibaba-photobank | 097bc292510b69169699c01c0d3eea7278d766b9 |

Runtime source is copied from those reviewed commits. The public package layout keeps the two modules adjacent so their existing relative imports resolve. Account bindings are local-only.
Photobank regression tests were rewritten with invented store keys and model labels. Draft regression tests use a purpose-built synthetic model instead of historical seller payloads. No business fixtures, original assets or real receipts are included.

The bulk editor adapts the established existing-product workflow. It retains the attribute, trade and sample edit sequence, single submit, and delayed official-version readback. The public batch runner binds seller expectations and the scope digest locally, and calls a transport supplied by the operator. Its fixture and fault cases use synthetic data.

## Documentation references

The README organization was informed by the public project pages of:

- [Playwright](https://github.com/microsoft/playwright): visible project purpose, setup and documentation entry points.
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp): explicit host requirements and capability boundaries.
- [p-limit](https://github.com/sindresorhus/p-limit): compact executable examples followed by focused API documentation.

The prose and examples here were written for this project. These projects are not bundled runtime dependencies, and their licenses are not being applied to their code through this repository.
This repository's original release is distributed under the MIT license in LICENSE.
