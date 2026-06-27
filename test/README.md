# Tests

Run all tests:

```bash
npm test
```

This uses Node's built-in test runner (`node --test`) — no external test framework.

## Coverage

| File | Subject |
| ---- | ------- |
| `hashUtil.test.js` | SHA-256 streaming + `filesMatch` content compare |
| `PromptWorkflowService.test.js` | Prompt assembly + RAG orchestration (pure + mocked) |
| `universal-pool-manager.test.js` | Generic-term detection, cross-contamination, validation |
| `ClassificationService.test.js` | Pure helpers from the waterfall (tokenize, normForDedup, etc.) |
| `ComplianceService.test.js` | Audit log rotation: nothing is dropped on overflow |

Tests target compiled `.js` outputs in `src/main/`, so run `npm run compile`
first if you've changed `.ts` sources.
