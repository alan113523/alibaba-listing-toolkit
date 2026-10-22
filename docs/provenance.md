# Release provenance

This public snapshot contains generic code from two locally maintained modules, accompanied by a rewritten workflow guide. It starts a new Git history and contains no private run history or seller configuration.

| Source module | Reviewed source revision |
| --- | --- |
| alibaba-draft-interface | 6285d4120127a0e90c83d652dacec0e7aa0de672 |
| alibaba-photobank | 097bc292510b69169699c01c0d3eea7278d766b9 |

Runtime source is copied from those reviewed commits. The public package layout keeps the two modules adjacent so their existing relative imports resolve. Account bindings are local-only.
Photobank regression tests were rewritten with invented store keys and model labels. Draft regression tests use a purpose-built synthetic model instead of historical seller payloads. No business fixtures, original assets or real receipts are included.

## Documentation references

The README organization was informed by the public project pages of:

- [Playwright](https://github.com/microsoft/playwright): visible project purpose, setup and documentation entry points.
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp): explicit host requirements and capability boundaries.
- [p-limit](https://github.com/sindresorhus/p-limit): compact executable examples followed by focused API documentation.

The prose and examples here were written for this project. These projects are not bundled runtime dependencies, and their licenses are not being applied to their code through this repository.
This repository's original release is distributed under the MIT license in LICENSE.
