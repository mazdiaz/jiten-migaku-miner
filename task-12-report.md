# Task 12 Evidence

- RED: `npm exec vitest run tests/app/services/anki-sync-service.test.ts` failed 3 regression tests before implementation.
- GREEN: same service suite passed 38/38 after implementation.
- Focused service/UI tests: `npm exec vitest run tests/app/services/anki-sync-service.test.ts tests/ui/anki-sync-view.test.ts tests/ui/anki-sync-controls.test.ts` passed 47/47.
- Full test suite: `npm test` passed 734/734 across 46 files.
- Typecheck: `npm run typecheck` passed.
- Format/check: Biome format and check passed for changed source/test files.
- Regression coverage: cancellation is ignored during durable replacement; failed Apply preserves candidate/private state for retry; stale Apply errors cannot overwrite newer previews.
