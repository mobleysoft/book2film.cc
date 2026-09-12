# Book2Film Shared-Capability Canary

Status: implemented backend canary, locally tested, NOT deployed or release-ready.
This folder does not replace the production screenplay checker in
`nginx/workers/venture-fleet/src/worker.js` or the historical staged worker.
No user-facing upload/review UI, payment flow, or production routing is included.

## Implemented Workflow

1. An explicitly enabled, email-allowlisted operator provides an AuthFor Bearer token.
2. `POST /api/source-text` accepts a PDF of at most 2 MiB. It calls the existing
   `OCR_SERVICE` at `https://internal/extract-text` using raw PDF bytes. The
   10-page hint is not represented as proof the entire book was processed.
3. The caller reads the returned text and chooses an excerpt of at most 850
   characters. No inference runs automatically during extraction.
4. `POST /api/storyboard`, JSON `{ "excerpt": "...", "approved": true }`, calls
   the existing Filmline service's `/api/generate`. The excerpt plus instruction
   fits its existing 1000-character premise contract without silent truncation.
5. The response contains proposed scenes and animated SVG, NOT an encoded film,
   a faithful whole-book adaptation, or a finished screenplay. Human review is
   explicitly required. Do not insert generated SVG into a privileged page DOM;
   display it in a sandbox without scripts or same-origin privileges.

The shared services remain the implementations of auth, OCR, and story generation.
No Claude API, Ron development proxy, new model download, or duplicate OCR engine
is introduced. Filmline's actual inspected source calls the existing fleet story
engine. Its real production model route still requires end-to-end verification
before this canary is promoted.

## Required Environment

- `CANARY_ENABLED=true`; otherwise every recognized endpoint returns 503.
- `CANARY_ALLOWED_EMAILS`: comma-separated test-operator allowlist; empty fails closed.
- `OCR_SERVICE`: same-account binding to `weyland-ocr-worker`.
- `FILMLINE_VIDEO`: same-account binding to `filmline-video-worker`.
- AuthFor is reached by public HTTPS GET `/api/v1/verify`, not a guessed service binding.

No Wrangler deployment configuration is supplied intentionally. Integration must
first select the correct account and staging entrypoint instead of publishing the
old `hascom/.deploy_armada_staging` proxy/landing-page artifact wholesale.

## Verification

Run `node --test integration-canary/worker.test.mjs` from this venture folder.
Tests exercise the actual canary code with controlled AuthFor/OCR/Filmline
transports. One composition test imports the real Filmline renderer and stubs
only its inference binding. These are NOT real-authenticated production PDF tests.

Before public promotion: authenticated real PDF -> selected excerpt -> real model
-> SVG; quality review; live screenplay-checker regression; account-specific
bindings; bounded user quotas and costs; upload/review UI; entitlement isolation;
failure/retry UX; rollout and rollback. Until those pass, no launch or revenue claim.
