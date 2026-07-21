# Free Trial & Licensing

How access works today, and what's still a manual step before this is fully live for paying customers (tracked in [DEPLOY.md](../../DEPLOY.md)).

## Workflow

![Trial & Licensing workflow](../diagrams/trial-and-licensing.svg)

1. Install and use the app free — no account, no key needed.
2. You get 300 file moves as a lifetime trial, per install.
3. Once the trial runs out, an in-app paywall appears with a checkout link.
4. After purchase, enter the license key in Settings → License.
5. The license is validated and cached, re-checked every 24 hours, with a 7-day offline grace period so travel or an outage never locks out a paying customer.

Undo/redo and any file-safety operations (like PII-secure moves) are **never** license-gated — your data access is never held hostage by a lapsed license.

## Current state (testing build)

- `TESTING_MODE` is currently on, so the trial/paywall limit isn't enforced during testing — you can use the app past 300 moves without hitting a wall.
- Licenses are device-bound (max 2 devices per key) once the backend migration for that is run; until then, validation "fails open."
- See [DEPLOY.md](../../DEPLOY.md) for the exact remaining steps before this goes live for real customers.

## Notes for testers

- You're not expected to hit the paywall in this build — that's intentional (testing mode).
- If you *do* see a paywall, that's worth reporting — it means testing mode isn't behaving as expected.
