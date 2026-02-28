# pi-context-lens

`pi-context-lens` is a Pi Coding Agent extension that reduces context bloat by scoring large tool results and replacing low-value content with concise summaries in the LLM view.

Current status: **initial implementation (Mode A / piggyback) scaffold**.

- Design: [`DESIGN.md`](./DESIGN.md)
- Source: [`src/index.ts`](./src/index.ts)

## Local development

```bash
npm install
npm run check
npm run build
```

## Validation

Run end-to-end phase-1 validation (typecheck + unit + flow tests):

```bash
npm run validate
```
