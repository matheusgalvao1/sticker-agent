# Sticker Agent — WhatsApp sticker bot

A WhatsApp assistant that creates and remixes WhatsApp stickers. One conversational agent decides what to do from whatever the user sends:

| The user sends | The agent |
| --- | --- |
| A text description | Generates an image, converts it to a sticker, and sends it. |
| Text plus photos | Uses the photos as references for the image model, then sends a sticker. |
| A sticker plus instructions | Converts the sticker to PNG, applies the change, and sends a sticker back. |
| A sticker or photo with no instruction, or an unclear request | Asks one question and generates nothing. |

Every successful turn returns a sticker and a short Portuguese reply. See `docs/PLAN.md` for the roadmap and the test strategy.

## Architecture

- **Fastify** receives Meta's webhook and verifies `X-Hub-Signature-256`. Each new message is saved as a job in SQLite before the webhook is acknowledged. Jobs run in a per-sender queue: bursts of messages are merged into one turn after a short grace window (`BATCH_WINDOW_SECONDS`, 5 seconds by default), and messages sent while a turn runs are attached to the agent's next tool result, so it adapts instead of restarting.
- **Bot** (`src/bot/sticker-bot.ts`) downloads incoming media into the conversation's asset store and runs one agent turn for the batch; the final reply text is sent after the turn.
- **Asset store** (`src/assets/store.ts`) keeps each sender's stickers and images with short IDs (`sticker_1`, `image_2`). Memory expires after `MEMORY_TTL_MINUTES` of inactivity.
- **Agent** (`src/agent/sticker-agent.ts`) uses the OpenAI Agents SDK through OpenRouter's Chat Completions endpoint. It has four tools:
  - `list_assets`: show the conversation's stickers and images.
  - `generate_image`: call the image model with a prompt and optional references.
  - `make_sticker`: convert an image to a WhatsApp sticker (no AI).
  - `send_sticker`: send the sticker to the user right now through WhatsApp — the tool result is the real delivery outcome, and the agent says the sticker was sent only when it returned `ok`.
- **Image model** (`src/openrouter/image-generator.ts`) calls OpenRouter's `POST /api/v1/images` with `input_references`. The default model is `openai/gpt-image-2.5-sunburst`.
- **Sticker pipeline** (`src/sticker/normalize.ts`) produces 512×512 WebP files under 100 KB. It also converts stickers to PNG and photos to JPEG for the image model, and rejects animated stickers.
- **Accounts** (`src/accounts/service.ts`) are keyed by WhatsApp number. The first message from an allowed number creates the account and sends a short welcome. There is no email or web sign-up.
- **Database** (`src/db/database.ts`) is SQLite via `better-sqlite3`, at `DATABASE_PATH`. It stores accounts, message jobs, daily generation counts, an audit log of every outbound message (`delivery_log`), and per-sender conversation history (`agent_sessions`) so context survives restarts and idle periods (`MEMORY_TTL_MINUTES`), kept to the newest ~30 items with tool-call integrity.
- **Services** (`src/services.ts`) wires everything together. Tests and the local harness replace WhatsApp and the image model with fakes.

Only numbers in `WHATSAPP_ALLOWED_NUMBERS` reach the bot. Daily generation is capped per sender by `DAILY_GENERATION_LIMIT`. A generation that fails is refunded.

## Requirements

- Node.js 22+
- An OpenRouter API key, with access to a tool-calling chat model and the configured image model
- For live use: a Meta developer app with a WhatsApp Cloud API number, and a public HTTPS URL for the webhook

## Setup

```bash
cp .env.example .env   # add OPENROUTER_API_KEY; WhatsApp values are only needed for live use
npm install
```

## Try it locally (no WhatsApp needed)

```bash
npm run sim                 # stub image generator; real agent model via OpenRouter
npm run sim -- --real-images   # also call the real image model
```

The harness starts the real HTTP server on `SIM_PORT` (default 3100) with a fresh database each run. It sends each line as a signed webhook request, so signature checks, deduplication, and the queue all run.

Your number is created on its first message, and you get a welcome. Numbers that are not in `WHATSAPP_ALLOWED_NUMBERS` are ignored.

Commands:

- `<text>`: send a text message
- `/sticker <spec|file>`: send a sticker, e.g. `/sticker sticker:red` or `/sticker ./my-sticker.webp`
- `/photo <spec|file> [caption]`: send a photo with an optional caption, e.g. `/photo photo:blue faz ela sorrir`
- `/new`: reset the conversation
- `/quit`: exit

Generated stickers are saved to `tmp/sim/out/`. Colors for samples: red, blue, green, orange, purple, yellow, gray.

## Evaluate the agent

```bash
npm run eval                  # real agent and real image model
npm run eval -- --stub-images # real agent, stub images (no image-model cost)
```

`evals/cases.json` lists scenarios with per-turn expectations: which tools must or must not run, and whether a sticker is sent. Each run writes `tmp/eval/<timestamp>/report.md` with the replies, tool calls, and the generated stickers. The command exits non-zero when any case fails. Add cases there when you find a new routing problem.

## Tests

```bash
npm run typecheck
npm test
npm run build
```

The tests cover asset memory, sticker conversion on real image files, the image-model request format, WhatsApp Graph calls, bot behavior, account creation, agent routing with the SDK's scripted model, and an end-to-end webhook flow.

## Going live

Configure Meta's webhook callback URL as `https://<your-host>/webhook` and subscribe to the `messages` field. `GET /webhook` answers the verification challenge, and `POST /webhook` validates signatures when `WHATSAPP_APP_SECRET` is set.

Routes:

- `GET /health`: liveness check
- `GET /webhook`: Meta verification handshake
- `POST /webhook`: WhatsApp Cloud API notifications

`WHATSAPP_ALLOWED_NUMBERS` is a comma-separated allowlist. Production startup rejects an empty allowlist. Use digits only, with country code, for example `5511999999999`.

## Current limits

- Conversation memory and recent images are in-process only. A restart loses them, so the bot forgets earlier stickers and photos when the machine sleeps.
- A job interrupted mid-reply runs again on the next start, so a reply can be sent twice if the restart happens right after sending.
- SQLite is a single-process database. Run one server instance.
- Credits are not implemented yet.
- Only static stickers are supported, for input and output.
- Input media is kept in memory and sent to the image provider. Retention rules are not enforced yet.
