# Sticker Agent Development Plan

This plan sequences the work from the current prototype toward the MVP described in the PRD. Its main goal is to make the product testable **without a live WhatsApp number**, so Meta setup happens late and only validates what is already proven locally.

Reference documents:

- PRD: `docs/PRD.md` (to be added from the attached PRD)
- Current state: `README.md`

## Status

| Phase | Status | Notes |
| --- | --- | --- |
| 0. Decisions and setup | Partly done | Product direction decided. Meta paperwork not started by this work. `docs/PRD.md` not added yet. |
| 1. Test seams and local harness | Done | `createServices`, `Clock`, configurable Graph URL, `npm run sim`, fake WhatsApp, stub images. |
| 2. Flexible agent core | Done | Single agent with four tools, asset store, PNG and JPEG references, animated-sticker rejection, daily limit with refunds. |
| 3. Real generation and evals | Done, with a caveat | `npm run eval` runs 10 cases. Ran with stub images: 10/10. Real image runs and pt-BR review still to do. Cost per generation not yet measured. |
| 4. Accounts | Done, simplified | No email or web sign-up. Accounts are keyed by WhatsApp number, and the allowlist controls access. This replaces PRD §5 (email login and linking codes), which we chose to skip for now. SQLite stores accounts. |
| 5. Credits and durable state | Not started | Needs Postgres and Redis (or equivalent) and the Phase 4 user model. |
| 6. Observability, safety, beta readiness | Not started | Depends on Phases 4 and 5. |
| 7. Live WhatsApp validation | Not started | Checklist in §5 is ready. Needs a Meta test number and a public HTTPS URL. |

## 0. Product direction (decided)

Sticker Agent is **one flexible sticker agent**, not a set of separate workflows. The user sends whatever they have (text, photos, stickers, or a mix), and the agent decides what to do:

| What the user sends | What the agent does |
| --- | --- |
| Text only | Generates an image from the description, then converts it to a sticker and sends it. |
| Text + one or more photos/images | Uses the references with the image model to create a new image, then converts it to a sticker. |
| A sticker (+ text) | Converts the sticker to a PNG so the image model can read it, applies the instructions, then converts the result back to a sticker. |
| A sticker with no instructions | Asks what to change. Does not generate. |
| Ambiguous or underspecified input | Asks one focused question. Does not generate. |
| Photo with no instructions | Asks what to make, or offers a default (decided per UX review). |

Every successful turn returns **a sticker plus a short text message**. Turns that do not produce a sticker return only text (usually a question).

The agent is the only decision-maker. Application code provides tools and guardrails; it does not hard-code the routing between flows.

### Consequences for the design

1. **Inputs are normalized to model-readable images.** WebP stickers are decoded to PNG with alpha before reaching the image model. This is the "sticker → image" step and is required for any sticker reference.
2. **Outputs are always normalized to WhatsApp stickers.** Every generated image goes through the same 512×512 WebP / ≤100 KB pipeline (`src/sticker/normalize.ts`).
3. **The agent keeps a per-user asset registry.** Each received or generated image gets a short ID (e.g., `img_1`, `stk_2`) stored for the conversation. Follow-ups like "make him wear sunglasses" resolve to the most recent sticker unless the user names another one.
4. **Tools, not flows.** The agent is given a small set of tools and chooses among them:
   - `list_assets()`: what the user has sent or received in this conversation, with types and IDs.
   - `generate_image({ prompt, reference_asset_ids[] })`: calls the image model. References can be photos, PNG-converted stickers, or previous outputs.
   - `make_sticker({ asset_id })`: converts an image asset to a WhatsApp sticker (no AI). Used for "just make this a sticker".
   - `send_sticker({ asset_id })`: delivers a sticker asset with the text reply.
   - `ask_user(question)` is not a tool. The agent asks by replying with text and no sticker.
5. **Guardrails outside the agent:** tool-call limit per turn, per-turn timeout, a daily generation budget, and a sanitized error message for the user. The agent cannot send stickers that did not pass normalization.
6. **Clarification is part of the conversation.** The agent should ask when intent is unclear, and must not spend a generation on guesses (the PRD's "insufficient information" case).

### What this replaces in the PRD

PRD Features 1–3 remain the user-visible capabilities (convert, remix, create), but they are reached through one agent rather than three commands or state machines. The PRD's `/create`, `/cancel`, `/credits`, and similar commands stay as optional shortcuts; they are not required for the agent to work. The remix state machine in PRD §6 is replaced by the agent's conversation memory and the 15-minute idle expiry on that memory.

## 1. Guiding principles

1. **Every product behavior runs in a local harness first.** WhatsApp is a transport. Business logic should be exercised through interfaces, with fakes for Meta.
2. **Test seams before features.** Some pieces (`index.ts`, the hard-coded Graph URL, the fixed WhatsApp client) are not injectable yet. Fix that once, early.
3. **Deterministic tests by default.** Real AI calls are opt-in, rate-limited, and never run in CI by default. Agent routing is tested with a scripted model, not a live one.
4. **Meta work runs in parallel, but is not on the critical path for code.** Business verification and app review can take days or weeks, so start them early without blocking development.

## 2. Test strategy (layers)

| Layer | What it proves | Needs WhatsApp? | Needs OpenRouter? | Runs in |
| --- | --- | --- | --- | --- |
| L1 Unit | Asset registry, normalization helpers, guardrails (tool limits, budget, timeouts), error sanitizing | No | No | `npm test` |
| L2 Media fixtures | Sticker → PNG (alpha kept) and image → sticker on real files (transparent PNG, huge photo, animated WebP/GIF, corrupt file) | No | No | `npm test` |
| L3 Contract | Request shapes to Graph API and OpenRouter (including the `input_references` format); webhook payloads match Meta's documented formats | No (fake Graph server) | No (fake server) | `npm test` |
| L4 Agent routing | Given an input situation, the agent calls the expected tools (or asks a question). Uses a scripted model that returns fixed tool calls. | No | No | `npm test` |
| L5 Local harness (`npm run sim`) | Real HTTP server, signed webhook payloads, terminal-driven conversation, outputs saved as `.webp` files | No | Optional (flag) | Manual |
| L6 AI evals (`npm run eval`) | Real routing and output quality over a fixed case set | No | Yes | Manual, cost-capped |
| L7 Live WhatsApp smoke | Real Meta webhook, media download, sticker delivery | Yes | Yes | Manual, last |

Priority: L1–L4 gate every change. L5 is the daily development loop. L6 gates prompt and model changes. L7 gates the Phase 1 exit criteria and the release.

### Test doubles to build

- **`FakeWhatsAppClient`**: implements `downloadMedia`, `sendText`, `sendSticker`. Records outbound messages in memory and writes each sticker to `tmp/sim/out/` as `.webp`.
- **`FakeGraphServer`**: a small local HTTP server that mimics `GET /{media-id}`, the media download URL, `POST /{phone-id}/media`, and `POST /{phone-id}/messages`. Used by L3 to test the real `WhatsAppCloudClient` without the network.
- **`StubImageGenerator`**: returns a fixture PNG. Records the references it received, so tests can assert that a sticker was converted to PNG before being sent. Lets L4/L5 run without spending credits.
- **`ScriptedAgentModel`**: a fake model for the agent SDK that returns a fixed sequence of tool calls and text. Used by L4 to test routing without a live model.

### Fixtures to collect

- `tests/fixtures/media/`: transparent PNG, opaque JPEG (phone photo, roughly 4000×3000), tiny 16×16 image, static WebP sticker with alpha, animated WebP, animated GIF, zero-byte file, text file renamed `.jpg`.
- `tests/fixtures/webhooks/`: real Meta payloads (text, image with caption, sticker, status update, unknown type). Use Meta's documented examples and redact any real numbers.
- `tests/fixtures/graph/`: sample Graph API responses (media metadata, upload id, error bodies with `error.message`).
- `evals/cases.json`: the eval set described in Phase 2.

## 3. Required refactors (Phase 1)

These are small changes that unlock testing without changing behavior:

1. **Extract a service factory.** Move the wiring out of `src/index.ts` into `createServices(config, overrides?)`, so the harness can swap in fakes. `index.ts` becomes a thin entry point.
2. **Make the Graph base URL configurable.** `WhatsAppCloudClient` builds `https://graph.facebook.com/...` inline. Accept a `graphBaseUrl` option defaulting to Meta's host, so L3 can point at `FakeGraphServer`.
3. **Make the OpenRouter image URL testable.** Same for the image generator, which already accepts `fetcher`. Confirm the constructor path is used everywhere.
4. **Add a `Clock` abstraction.** Draft TTL, the 15-minute memory expiry, and the 10-minute auth session expiry all depend on time. Tests should advance time instead of sleeping.
5. **Add an outbound abstraction** so the bot does not know whether it talks to WhatsApp, the terminal, or a test recorder.

After these, `src/index.ts` should have no logic that tests cannot reach.

## 4. Phases

Each phase lists its exit criteria. A phase is done only when its tests pass and the L5 harness shows the behavior end to end.

### Phase 0 — Decisions and setup (days)

- Add `docs/PRD.md` and link it from the README.
- Create `.env.example` entries for any new variables (Graph URL override, sim mode, eval budget, daily generation budget).
- **Start Meta paperwork now** (parallel track, see §6).
- Agree on the output folder for harness artifacts (`tmp/sim/`, git-ignored).

### Phase 1 — Test seams and local harness

Build the §3 refactors, then:

- `npm run sim`: starts the Fastify app on localhost with `FakeWhatsAppClient` and `StubImageGenerator`. A terminal prompt lets you act as the user:
  - `/sticker <file>` sends a sticker from a fixture or local file.
  - `/image <file> [caption]` sends a photo.
  - `/text <message>` sends a text message.
  - Outbound bot replies print to the terminal. Stickers save to `tmp/sim/out/`.
  - Each command posts a real HMAC-signed webhook payload to `/webhook`, so the signature, dedup, and queue code run for real.
- L2 media fixture tests for `normalizeSticker`: output is 512×512, WebP, ≤100 KB, transparency preserved when the input has alpha, and a clear error for corrupt input.
- L3 Graph contract tests: media download, upload-then-send ordering, error mapping, timeouts.
- Webhook fixture tests: status-only payloads and unknown message types are ignored without errors.

**Exit criteria:** `npm run sim` runs the current flow locally and produces a valid `.webp`. All L1–L4 tests pass. A fresh clone can run the harness with only an `.env` file that has dummy values.

### Phase 2 — Flexible agent core

Replace the composite draft flow with the single agent described in §0. The current `DraftStore` (which requires sticker + selfie + prompt) is retired.

- **Asset registry:** per-user store of received and generated assets, with IDs, types (`sticker`, `image`), source message IDs, and expiry. Replaces the draft.
- **Media conversion helpers:**
  - `stickerToPng(webp)`: decodes an animated-or-static WebP sticker to PNG with alpha. Static only for the MVP; animated stickers get a clear "not supported yet" reply.
  - `imageToSticker(buffer)`: the existing `normalizeSticker`.
- **Tools** (§0 item 4): `list_assets`, `generate_image`, `make_sticker`, `send_sticker`. Each tool returns structured results the agent can read back.
- **Guardrails:** max tool calls per turn (e.g., 4), per-turn timeout, daily generation budget, and sanitized errors.
- **Image model adapter:** the current OpenRouter adapter accepts references as images. Confirm it accepts PNG references and returns PNG; keep the `StickerImageGenerator` interface and rename it to match §0 if needed.
- **Reply format:** each turn yields `{ text, stickerAssetId? }`. The bot sends text, and the sticker if present.

**Tests:**

- L4 routing tests with `ScriptedAgentModel`:
  - Text only → `generate_image` then `make_sticker` then `send_sticker`.
  - Photo + text → `generate_image` with the photo as a reference.
  - Sticker + "make him wear sunglasses" → sticker converted to PNG, `generate_image` with that reference, result sent as a sticker.
  - Sticker alone → text question, no generation.
  - Photo alone → text question (or the default chosen in UX review).
  - Follow-up "make it blue" after a sticker → resolves to the latest sticker asset.
  - Two stickers and "use the first one" → resolves to the named asset.
- L2 tests: sticker → PNG keeps transparency; PNG → sticker meets size and format limits.
- L1 tests: tool-call limit stops a runaway loop; budget exhaustion returns a clear message and no generation.

**Exit criteria:** All L4 routing cases pass. `npm run sim` handles text-only, photo-with-text, and sticker-with-text inputs end to end with the stub generator, and the sticker reference reaches the stub as a PNG.

### Phase 3 — Real image generation and evals

- Connect the real image model through the Phase 2 adapter.
- Conversation memory expires after 15 minutes of inactivity (PRD remix expiry, now applied to the agent's memory).
- Retry rules: a failed generation keeps the user's inputs; the agent offers to retry in its reply, and `/retry` is available as a shortcut.
- Failed generations do not consume credits (credits come in Phase 5, but the rule is set now).
- User-facing copy moves to pt-BR (PRD §15). The agent's system prompt is written in English but must instruct it to reply in pt-BR.

**Testing the AI itself (L6 evals):**

- `evals/cases.json` with 30–40 cases, each with inputs (text, photos, stickers, history), expected behavior (`generate`, `ask`, or `refuse`), and optional checks. Cases cover:
  - Text-only descriptions in Portuguese and English.
  - Photo references (one and several).
  - Sticker remixes ("de óculos", "com chapéu de cowboy").
  - Sticker-only inputs that must produce a question.
  - Ambiguous follow-ups and references to earlier assets.
  - Unsafe requests that must be refused.
  - Requests for text inside the image (should be honored or declined as the product decides).
- `npm run eval` runs the cases against the real provider, saves outputs, and writes a Markdown or HTML report with thumbnails.
- Automatic checks: routing matches the expected behavior; output passes format checks (512×512, WebP, ≤100 KB, alpha when expected); reply is in pt-BR.
- Manual scoring 1–3 per case for quality, at first.
- Record cost per case from the provider response to start the PRD's cost-per-generation measurement.
- Run evals only when prompts, the model, or the image pipeline change. Put a budget cap on the command.

**Exit criteria:** No routing or format failures in the eval set. Median generation time and cost per generation are recorded.

### Phase 4 — Accounts and WhatsApp linking (PRD §5)

Build this with the fake WhatsApp client. The linking protocol (PRD §5.5) is the highest-risk security area, so test it heavily.

- Database schema for `User`, `WhatsAppIdentity`, `AuthSession`. Use Postgres in a local container (`docker compose up db`) so that dev and prod behave the same.
- Web app (Next.js per PRD §10.1) with Google OAuth. For local tests, use a mock OAuth provider that returns a fixed identity.
- Registration session flow: create a short-lived session bound to the WhatsApp sender, hash its token, show the confirmation code on the web page, accept `/confirm CODE`, and link atomically.
- Gate all agent actions behind a registered account. Unregistered senders get the registration prompt from the agent's text reply, without any tool access.

**Tests:**

- Session expiry at 10 minutes (fake clock).
- Single-use codes: second `/confirm` fails.
- Retry limit: N wrong codes locks the session.
- One WhatsApp ID cannot link to two accounts; re-linking without authorization fails.
- Concurrent `/confirm` calls: only one succeeds (DB constraint test).
- Unregistered sender: no tool is called, the registration prompt is sent.
- Mock-Google end-to-end in the harness: `/auth` → open link → sign in (mock) → `/confirm` → registered.

**Exit criteria:** The full registration flow passes in `npm run sim` using the mock OAuth provider. Security tests pass.

### Phase 5 — Credits, durable state, and reliability (PRD §8, §9, §12.2)

- Credit ledger with `reserved`, `committed`, `released` states. Enforce "no double-spend" with a DB constraint and a transaction on reserve. Each agent turn that calls `generate_image` reserves credits before the call; a conversation that only asks questions costs nothing.
- Config-driven credit costs (PRD §8.1).
- Move asset registry, conversation memory, and job state to Postgres. Use BullMQ on Redis for the job queue (PRD §10.1). Add `docker compose` for Redis.
- Idempotency: unique constraints on `sourceMessageId` so duplicate webhooks never create a second turn or charge.
- Turn timeouts, retry policy, and "stuck job" recovery (a sweeper job).
- Failed delivery produces a recoverable state: the credit stays reserved and is committed or released based on the final outcome, never lost silently.
- Media cleanup job for the PRD retention rules (source deleted within 24 h, outputs within 7 days). Asset registry entries follow the same rules.

**Tests:**

- Property-style test: random sequences of reserve/commit/release/cancel never leave a negative balance or an orphan reservation.
- Concurrency test: 20 parallel requests with 3 credits yield exactly 3 successes.
- Crash simulation: kill the worker mid-generation; the turn recovers and does not charge twice.
- Duplicate webhook storm: the same payload delivered 50 times produces one turn.
- Retention test with a fake clock: files older than the limit are deleted; newer files are kept.
- Clarifying-question turns cost zero credits (assert against the ledger).

**Exit criteria:** The PRD §20 items 10–12 pass in automated tests.

### Phase 6 — Observability, safety, and beta readiness (PRD §12.3–§14)

- Structured logs that never include images or tokens (add a test that scans log output for a fake token).
- Metrics and the PRD's analytics events (`auth_started`, `generation_completed`, and so on), with a dashboard query or simple internal page.
- Rate limiting per sender and per account.
- Content safety: provider policy handling, a `/help` path for reports, and a manual copyright-complaint process documented in the Terms.
- Account commands (`/account`, `/history`, `/delete`, P1). `/delete` must remove media and identity links, and a test should verify that.
- Terms of Service and Privacy Policy pages (required before beta).
- Copy review in pt-BR with at least one native speaker.

**Exit criteria:** PRD Definition of Done item 13 passes. The internal cost dashboard shows real eval numbers.

### Phase 7 — WhatsApp live validation and private beta (PRD §17 Phase 5)

Only after Phases 1–6 pass locally. The WhatsApp work is short because the logic is already tested.

## 5. WhatsApp live validation checklist

Run this once the Meta app and test number exist. Each step should already work in `npm run sim`, so failures here point to Meta configuration, not to the code.

1. Expose the local server with a tunnel (e.g. Cloudflare Tunnel or ngrok) and set the webhook URL to `https://<tunnel>/webhook`.
2. `GET /webhook` verification succeeds with the verify token.
3. Send a text from the test number: webhook arrives, signature is valid, bot replies.
4. Text-only description: the bot returns a sticker and a short text.
5. Send a sticker with an instruction: the bot returns a modified sticker.
6. Send a sticker with no instruction: the bot asks a question and no sticker is sent.
7. Send a photo with and without a caption.
8. Confirm a bot-generated sticker displays as a sticker in WhatsApp and can be saved to favorites (PRD Feature 1 acceptance).
9. Send the same message twice (resend): only one response.
10. Send an unsupported type (video, document): clear error, no crash.
11. Send a message from a non-allowlisted number: ignored.
12. Check logs for any media or token leakage.
13. Confirm 24-hour window handling: a reply sent outside the window must use an approved template (PRD §13). Test this explicitly before beta.

## 6. Parallel track: Meta setup

Start in Phase 0. These steps can take longer than the code.

- Meta Business account and business verification (may require documents; start early).
- Meta developer app with WhatsApp product.
- Test phone number (Meta provides one) for early testing; a real number is needed for beta.
- Access token strategy: a temporary token for development, a system user token for production. Store secrets outside the repo.
- Webhook subscriptions: `messages` field.
- Review the Business Messaging Policy and AI policy notes in PRD §13 before beta.
- Choose the production hosting target so the webhook URL is stable.

## 7. Open questions

1. Photo alone with no instruction: ask what to make, or offer a default?
2. Database for prototype work: Postgres in Docker from the start (matches PRD), or SQLite for a faster first iteration?
3. Which image provider to evaluate first, and what is the monthly eval budget?
4. Should animated stickers be rejected with a message in MVP, or converted to a static frame?
5. Who reviews the pt-BR copy and the eval ratings?
6. Is there a timeline for beta, which sets how much of Phase 6 is required?

## 8. Definition of "ready for WhatsApp"

- L1–L4 tests pass in CI on a clean checkout.
- `npm run sim` handles text-only, photo-with-text, and sticker-with-text inputs, and outputs are visually checked.
- At least one eval run is recorded with routing and format pass rates and cost per generation.
- Secrets handling and log scrubbing are tested.
- The live checklist in §5 is written down with owners and expected results.
