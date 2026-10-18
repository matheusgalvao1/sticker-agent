import OpenAI from 'openai';
import { Agent, MemorySession, OpenAIProvider, Runner, setTracingDisabled, tool, type ModelProvider } from '@openai/agents';
import { z } from 'zod';
import type { AssetStore, StoredAsset } from '../assets/store.js';
import type { Clock } from '../clock.js';
import type { ImageGenerator } from '../openrouter/image-generator.js';
import { normalizeSticker, toModelReference, type ModelReference } from '../sticker/normalize.js';
import type { DailyGenerationLimit } from './budget.js';

export interface AgentConfig {
  apiKey: string;
  baseUrl: string;
  agentModel: string;
  siteUrl: string;
  appName: string;
}

export interface AgentSessionStore {
  get(sender: string): MemorySession;
  clear(sender: string): Promise<void>;
}

export class InMemoryAgentSessionStore implements AgentSessionStore {
  private readonly sessions = new Map<string, { session: MemorySession; updatedAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly clock: Clock,
  ) {}

  get(sender: string): MemorySession {
    const existing = this.sessions.get(sender);
    const currentTime = this.clock.now();

    if (existing && currentTime - existing.updatedAt <= this.ttlMs) {
      existing.updatedAt = currentTime;
      return existing.session;
    }

    const session = new MemorySession({ sessionId: `whatsapp:${sender}` });
    this.sessions.set(sender, { session, updatedAt: currentTime });
    return session;
  }

  async clear(sender: string): Promise<void> {
    const existing = this.sessions.get(sender);
    if (existing) await existing.session.clearSession();
    this.sessions.delete(sender);
  }
}

export interface AgentTurnInput {
  sender: string;
  /** Text from the message, or the photo caption. Empty when the message had neither. */
  userText: string;
  /** Assets that arrived with this message. */
  newAssetIds: string[];
}

export interface ToolTraceEntry {
  tool: string;
  args: unknown;
  result: unknown;
}

export interface AgentTurnResult {
  text: string;
  stickerIds: string[];
  trace: ToolTraceEntry[];
}

export interface AgentTurnRunner {
  runTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
  reset(sender: string): Promise<void>;
}

export interface StickerAgentDependencies {
  config: AgentConfig;
  imageGenerator: ImageGenerator;
  assets: AssetStore;
  sessions: AgentSessionStore;
  budget: DailyGenerationLimit;
  modelProvider?: ModelProvider | undefined;
}

const MAX_TURNS = 8;

const INSTRUCTIONS = [
  'You are Sticker Agent, a WhatsApp sticker creator. Users write in Brazilian Portuguese and may send text, photos, and WhatsApp stickers in any combination.',
  'Decide what to do from the new message and the conversation’s assets:',
  '- Text only: generate_image from the description, then make_sticker, then send_sticker.',
  '- Text with photos: generate_image with those photos as references, then make_sticker, then send_sticker.',
  '- Sticker with an instruction: generate_image with the sticker as a reference, then make_sticker, then send_sticker.',
  '- A sticker or photo with no instruction, or an unclear request: generate nothing. Reply with one short question about what to make or change.',
  '- “Make it a sticker” for an existing image: make_sticker, then send_sticker, without generating.',
  'Follow-ups refer to the most recent sticker or image unless the user names another one. Use list_assets when you need details.',
  'When you write an image prompt, write it in English. Describe the subject, pose, expression, and style, keep the user’s requested joke and details, and say what each reference (1, 2, …) contributes in the order given.',
  'Only call send_sticker for a sticker asset. If send_sticker fails, fix it or explain the problem.',
  'After a sticker is sent, reply with one short, friendly message in Brazilian Portuguese. Never claim a sticker was sent unless send_sticker succeeded. Do not mention tools or internal IDs.',
  'If a tool returns an error, explain it simply in Brazilian Portuguese and suggest a next step.',
].join('\n');

interface TurnState {
  sender: string;
  stickerIds: string[];
  trace: ToolTraceEntry[];
}

export class StickerAgent implements AgentTurnRunner {
  private readonly runner: Runner;

  constructor(private readonly dependencies: StickerAgentDependencies) {
    const modelProvider = dependencies.modelProvider ?? createOpenRouterProvider(dependencies.config);
    this.runner = new Runner({ modelProvider });
  }

  async runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    const state: TurnState = { sender: input.sender, stickerIds: [], trace: [] };
    const agent = new Agent({
      name: 'Sticker Agent',
      model: this.dependencies.config.agentModel,
      instructions: INSTRUCTIONS,
      tools: this.createTools(state),
    });

    const result = await this.runner.run(agent, this.describeTurn(input), {
      session: this.dependencies.sessions.get(input.sender),
      maxTurns: MAX_TURNS,
    });

    const text = finalOutputAsText(result.finalOutput) || fallbackReply(state.stickerIds.length > 0);
    return { text, stickerIds: [...state.stickerIds], trace: state.trace };
  }

  async reset(sender: string): Promise<void> {
    await this.dependencies.sessions.clear(sender);
  }

  private describeTurn(input: AgentTurnInput): string {
    const { assets } = this.dependencies;
    const attached = input.newAssetIds
      .map((id) => assets.get(input.sender, id))
      .filter((asset): asset is StoredAsset => asset !== undefined)
      .map(describeAsset);
    const all = assets.list(input.sender).map(describeAsset);

    return [
      `New message from the user: ${input.userText ? `"${input.userText}"` : '(no text)'}`,
      `Attached to this message: ${attached.length > 0 ? attached.join('; ') : 'nothing'}`,
      `Assets in this conversation: ${all.length > 0 ? all.join('; ') : 'none'}`,
    ].join('\n');
  }

  private createTools(state: TurnState) {
    const { assets, imageGenerator, budget } = this.dependencies;
    const { sender } = state;

    const reply = (name: string, args: unknown, result: Record<string, unknown>): string => {
      state.trace.push({ tool: name, args, result });
      return JSON.stringify(result);
    };
    const lookup = (id: string) => assets.get(sender, id);

    return [
      tool({
        name: 'list_assets',
        description: 'List the stickers and images in this conversation, with their IDs, kinds, and origins.',
        parameters: z.object({}),
        execute: async () => reply('list_assets', {}, {
          assets: assets.list(sender).map((asset) => ({
            id: asset.id,
            kind: asset.kind,
            origin: asset.origin,
          })),
        }),
      }),

      tool({
        name: 'generate_image',
        description: 'Create a new image from a prompt, optionally using existing stickers or photos as references. Returns the new image asset ID. Pass an empty list for text-only requests.',
        parameters: z.object({
          prompt: z.string().min(1).max(3000).describe(
            'Detailed English image prompt: subject, pose, expression, style, and the role of each reference (reference 1, reference 2, …).',
          ),
          reference_asset_ids: z.array(z.string()).max(4).describe(
            'Asset IDs to use as references, in the order they should be described. Empty when there are none.',
          ),
        }),
        execute: async ({ prompt, reference_asset_ids }) => {
          const args = { prompt, reference_asset_ids };

          const references: ModelReference[] = [];
          for (const id of reference_asset_ids) {
            const asset = lookup(id);
            if (!asset) return reply('generate_image', args, { error: `Unknown asset ID ${id}.` });
            try {
              references.push(await toModelReference(asset));
            } catch (error) {
              return reply('generate_image', args, { error: errorMessage(error) });
            }
          }

          if (!budget.tryConsume(sender)) {
            return reply('generate_image', args, {
              error: 'The daily generation limit was reached. Tell the user to try again tomorrow.',
            });
          }

          try {
            const png = await imageGenerator.generate({ prompt, references });
            const stored = assets.add(sender, {
              kind: 'image',
              origin: 'generated',
              mimeType: 'image/png',
              data: png,
            });
            return reply('generate_image', args, { asset_id: stored.id });
          } catch (error) {
            budget.refund(sender);
            return reply('generate_image', args, { error: `Image generation failed: ${errorMessage(error)}` });
          }
        },
      }),

      tool({
        name: 'make_sticker',
        description: 'Convert an image or sticker asset into a WhatsApp sticker (512×512 WebP, under 100 KB). Uses no AI. Returns the sticker asset ID.',
        parameters: z.object({
          asset_id: z.string().describe('The image or sticker asset to convert.'),
        }),
        execute: async ({ asset_id }) => {
          const args = { asset_id };
          const asset = lookup(asset_id);
          if (!asset) return reply('make_sticker', args, { error: `Unknown asset ID ${asset_id}.` });

          try {
            const webp = await normalizeSticker(asset.data);
            const stored = assets.add(sender, {
              kind: 'sticker',
              origin: 'generated',
              mimeType: 'image/webp',
              data: webp,
            });
            return reply('make_sticker', args, { asset_id: stored.id });
          } catch (error) {
            return reply('make_sticker', args, { error: errorMessage(error) });
          }
        },
      }),

      tool({
        name: 'send_sticker',
        description: 'Send a sticker asset to the user in WhatsApp. The sticker is delivered after your reply is composed.',
        parameters: z.object({
          asset_id: z.string().describe('A sticker asset ID (not an image).'),
        }),
        execute: async ({ asset_id }) => {
          const args = { asset_id };
          const asset = lookup(asset_id);
          if (!asset) return reply('send_sticker', args, { error: `Unknown asset ID ${asset_id}.` });
          if (asset.kind !== 'sticker') {
            return reply('send_sticker', args, { error: 'Only sticker assets can be sent. Run make_sticker first.' });
          }

          if (!state.stickerIds.includes(asset_id)) state.stickerIds.push(asset_id);
          return reply('send_sticker', args, { ok: true, asset_id });
        },
      }),
    ];
  }
}

function createOpenRouterProvider(config: AgentConfig): ModelProvider {
  // Traces would be exported to OpenAI, which is not a provider here and would receive user content.
  setTracingDisabled(true);
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    defaultHeaders: {
      'HTTP-Referer': config.siteUrl,
      'X-OpenRouter-Title': config.appName,
    },
  });

  return new OpenAIProvider({ openAIClient: client, useResponses: false });
}

function describeAsset(asset: StoredAsset): string {
  const origin = asset.origin === 'user' ? 'sent by the user' : 'created by you';
  return `${asset.id} (${asset.kind}, ${origin})`;
}

function finalOutputAsText(output: unknown): string {
  if (typeof output === 'string') return output.trim();
  if (output === null || output === undefined) return '';
  return String(output).trim();
}

function fallbackReply(hasSticker: boolean): string {
  return hasSticker
    ? 'Pronto! ✨'
    : 'Não consegui concluir isso agora. Pode reformular ou tentar de novo em instantes?';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : 'Unknown error.';
}
