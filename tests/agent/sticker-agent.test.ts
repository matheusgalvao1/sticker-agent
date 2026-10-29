import sharp from 'sharp';
import { ScriptedModel, assistantMessage, functionCall, type ScriptedModelInput } from '@openai/agents/testing';
import { describe, expect, it, vi } from 'vitest';
import { DailyGenerationLimit } from '../../src/agent/budget.js';
import { InMemoryAgentSessionStore, StickerAgent } from '../../src/agent/sticker-agent.js';
import { AssetStore } from '../../src/assets/store.js';
import { openDatabase } from '../../src/db/database.js';
import { PendingInputs } from '../../src/jobs/pending-inputs.js';
import type { ImageGenerator } from '../../src/openrouter/image-generator.js';
import { loadMediaSpec } from '../../src/sim/fixtures.js';
import { StubImageGenerator } from '../../src/sim/stub-image-generator.js';

const sender = 'routing-test';

interface Harness {
  agent: StickerAgent;
  assets: AssetStore;
  model: ScriptedModel;
}

function setup(
  script: ScriptedModelInput[],
  options: { imageGenerator?: ImageGenerator; dailyLimit?: number; notifyGenerationStart?: (sender: string) => Promise<void>; pendingInputs?: PendingInputs } = {},
): Harness {
  const clock = { now: () => 1_000 };
  const assets = new AssetStore(60_000, clock);
  const model = new ScriptedModel(script);
  const agent = new StickerAgent({
    config: {
      apiKey: 'test',
      baseUrl: 'http://localhost',
      agentModel: 'test-model',
      siteUrl: 'http://localhost',
      appName: 'test',
    },
    imageGenerator: options.imageGenerator ?? new StubImageGenerator(),
    assets,
    sessions: new InMemoryAgentSessionStore(60_000, clock),
    budget: new DailyGenerationLimit(openDatabase(':memory:'), options.dailyLimit ?? 20, clock),
    notifyGenerationStart: options.notifyGenerationStart,
    pendingInputs: options.pendingInputs,
    modelProvider: { getModel: () => model },
  });
  return { agent, assets, model };
}

async function attach(assets: AssetStore, kind: 'sticker' | 'image', spec: string): Promise<string> {
  const media = await loadMediaSpec(spec);
  return assets.add(sender, { kind, origin: 'user', mimeType: media.mimeType, data: media.data }).id;
}

function generate(prompt: string, referenceIds: string[], callId: string) {
  return functionCall('generate_image', { prompt, reference_asset_ids: referenceIds }, { callId });
}

function makeSticker(assetId: string, callId: string) {
  return functionCall('make_sticker', { asset_id: assetId }, { callId });
}

function sendSticker(assetId: string, callId: string) {
  return functionCall('send_sticker', { asset_id: assetId }, { callId });
}

describe('StickerAgent routing', () => {
  it('notifies before generating an image', async () => {
    const notify = vi.fn(async () => undefined);
    const { agent } = setup([
      [generate('a cat astronaut', [], 'call-1')],
      [assistantMessage('Feito!')],
    ], { notifyGenerationStart: notify });

    await agent.runTurn({ sender, userText: 'um gato astronauta', newAssetIds: [] });

    expect(notify).toHaveBeenCalledWith(sender);
  });

  it('attaches newer user messages at the next tool boundary', async () => {
    const pendingInputs = new PendingInputs();
    pendingInputs.add(sender, { jobId: 9, text: 'muda pra azul', assetIds: [] });
    const { agent } = setup([
      [generate('cat', [], 'call-1')],
      [assistantMessage('ok, azul!')],
    ], { pendingInputs });

    const result = await agent.runTurn({ sender, userText: 'um gato', newAssetIds: [] });

    const generateCall = result.trace.find((entry) => entry.tool === 'generate_image');
    expect(generateCall?.result).toMatchObject({ new_user_messages: { texts: ['muda pra azul'] } });
  });
  it('turns a text-only description into a sticker', async () => {
    const { agent, model } = setup([
      [generate('A fat orange cat wearing sunglasses.', [], 'c1')],
      [makeSticker('image_1', 'c2')],
      [sendSticker('sticker_2', 'c3')],
      [assistantMessage('Prontinho! 😎')],
    ]);

    const result = await agent.runTurn({ sender, userText: 'um gato laranja de óculos', newAssetIds: [] });

    expect(result.stickerIds).toEqual(['sticker_2']);
    expect(result.text).toBe('Prontinho! 😎');
    expect(result.trace.map((entry) => entry.tool)).toEqual(['generate_image', 'make_sticker', 'send_sticker']);
    model.assertComplete();
  });

  it('uses a photo as a reference when the message has text', async () => {
    const generator = new StubImageGenerator();
    const { agent, assets, model } = setup([
      [generate('The person from reference 1 looks excited with confetti.', ['image_1'], 'c1')],
      [makeSticker('image_2', 'c2')],
      [sendSticker('sticker_3', 'c3')],
      [assistantMessage('Feito!')],
    ], { imageGenerator: generator });
    await attach(assets, 'image', 'photo:blue');

    const result = await agent.runTurn({ sender, userText: 'faz essa pessoa animada', newAssetIds: ['image_1'] });

    expect(result.stickerIds).toEqual(['sticker_3']);
    expect(generator.calls[0]?.references.map((reference) => reference.mimeType)).toEqual(['image/jpeg']);
    model.assertComplete();
  });

  it('converts a sticker to PNG before using it as an image reference', async () => {
    const generator = new StubImageGenerator();
    const { agent, assets } = setup([
      [generate('The cat from reference 1 wears a cowboy hat.', ['sticker_1'], 'c1')],
      [makeSticker('image_2', 'c2')],
      [sendSticker('sticker_3', 'c3')],
      [assistantMessage('Pronto, com chapéu!')],
    ], { imageGenerator: generator });
    await attach(assets, 'sticker', 'sticker:red');

    const result = await agent.runTurn({ sender, userText: 'coloca um chapéu de cowboy nele', newAssetIds: ['sticker_1'] });

    expect(result.stickerIds).toEqual(['sticker_3']);
    const [reference] = generator.calls[0]?.references ?? [];
    expect(reference?.mimeType).toBe('image/png');
    expect((await sharp(reference?.data ?? Buffer.alloc(0)).metadata()).hasAlpha).toBe(true);
  });

  it('asks a question for a sticker with no instruction and generates nothing', async () => {
    const generator = new StubImageGenerator();
    const { agent, assets } = setup([
      [assistantMessage('O que você quer mudar nessa figurinha?')],
    ], { imageGenerator: generator });
    await attach(assets, 'sticker', 'sticker:red');

    const result = await agent.runTurn({ sender, userText: '', newAssetIds: ['sticker_1'] });

    expect(result.stickerIds).toEqual([]);
    expect(result.text).toBe('O que você quer mudar nessa figurinha?');
    expect(generator.calls).toHaveLength(0);
  });

  it('converts an existing photo without calling the image model when asked to keep it', async () => {
    const generator = new StubImageGenerator();
    const { agent, assets, model } = setup([
      [makeSticker('image_1', 'c1')],
      [sendSticker('sticker_2', 'c2')],
      [assistantMessage('Aqui está!')],
    ], { imageGenerator: generator });
    await attach(assets, 'image', 'photo:green');

    const result = await agent.runTurn({ sender, userText: 'só transforma em figurinha', newAssetIds: ['image_1'] });

    expect(result.stickerIds).toEqual(['sticker_2']);
    expect(generator.calls).toHaveLength(0);
    model.assertComplete();
  });

  it('reports an unknown asset ID back to the model instead of failing the turn', async () => {
    const generator = new StubImageGenerator();
    const { agent } = setup([
      [generate('A dog.', ['sticker_9'], 'c1')],
      [assistantMessage('Não encontrei essa figurinha. Pode reenviar?')],
    ], { imageGenerator: generator });

    const result = await agent.runTurn({ sender, userText: 'usa a figurinha 9', newAssetIds: [] });

    expect(generator.calls).toHaveLength(0);
    expect(result.trace[0]?.result).toEqual({ error: 'Unknown asset ID sticker_9.' });
    expect(result.stickerIds).toEqual([]);
  });

  it('rejects animated stickers as references', async () => {
    const generator = new StubImageGenerator();
    const { agent, assets } = setup([
      [generate('A dog.', ['sticker_1'], 'c1')],
      [assistantMessage('Essa figurinha é animada, e ainda não consigo usar animações.')],
    ], { imageGenerator: generator });
    const frame = (red: number) =>
      sharp({ create: { width: 64, height: 64, channels: 4, background: { r: red, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    const animated = await sharp([await frame(255), await frame(0)], { join: { animated: true } }).webp().toBuffer();
    assets.add(sender, { kind: 'sticker', origin: 'user', mimeType: 'image/webp', data: animated });

    const result = await agent.runTurn({ sender, userText: 'usa essa', newAssetIds: ['sticker_1'] });

    expect(generator.calls).toHaveLength(0);
    expect(result.trace[0]?.result).toEqual({
      error: 'Animated stickers are not supported yet. Send a static sticker or a photo.',
    });
  });

  it('stops generating once the daily limit is reached', async () => {
    const generator = new StubImageGenerator();
    const { agent } = setup([
      [generate('A cat.', [], 'c1')],
      [makeSticker('image_1', 'c2')],
      [sendSticker('sticker_2', 'c3')],
      [assistantMessage('Pronto!')],
      [generate('A dog.', [], 'c4')],
      [assistantMessage('Você atingiu o limite de hoje.')],
    ], { imageGenerator: generator, dailyLimit: 1 });

    await agent.runTurn({ sender, userText: 'um gato', newAssetIds: [] });
    const second = await agent.runTurn({ sender, userText: 'um cachorro', newAssetIds: [] });

    expect(generator.calls).toHaveLength(1);
    expect(second.trace[0]?.result).toMatchObject({ error: expect.stringContaining('daily generation limit') });
  });

  it('refunds the daily allowance when the image model fails', async () => {
    let attempts = 0;
    const flaky: ImageGenerator = {
      async generate() {
        attempts += 1;
        if (attempts === 1) throw new Error('upstream timeout');
        return new StubImageGenerator().generate({ prompt: '', references: [] });
      },
    };
    const { agent } = setup([
      [generate('A cat.', [], 'c1')],
      [assistantMessage('Falhou, tente de novo.')],
      [generate('A cat.', [], 'c2')],
      [makeSticker('image_1', 'c3')],
      [sendSticker('sticker_2', 'c4')],
      [assistantMessage('Agora foi!')],
    ], { imageGenerator: flaky, dailyLimit: 1 });

    const failed = await agent.runTurn({ sender, userText: 'um gato', newAssetIds: [] });
    const retried = await agent.runTurn({ sender, userText: 'tenta de novo', newAssetIds: [] });

    expect(failed.trace[0]?.result).toMatchObject({ error: expect.stringContaining('upstream timeout') });
    expect(retried.stickerIds).toEqual(['sticker_2']);
  });

  it('only sends sticker assets', async () => {
    const { agent } = setup([
      [generate('A cat.', [], 'c1')],
      [sendSticker('image_1', 'c2')],
      [assistantMessage('Erro ao enviar.')],
    ]);

    const result = await agent.runTurn({ sender, userText: 'um gato', newAssetIds: [] });

    expect(result.stickerIds).toEqual([]);
    expect(result.trace[1]?.result).toMatchObject({ error: expect.stringContaining('make_sticker') });
  });

  it('falls back to a short reply when the model returns no text', async () => {
    const { agent } = setup([
      [generate('A cat.', [], 'c1')],
      [makeSticker('image_1', 'c2')],
      [sendSticker('sticker_2', 'c3')],
      [assistantMessage('')],
    ]);

    const result = await agent.runTurn({ sender, userText: 'um gato', newAssetIds: [] });

    expect(result.stickerIds).toEqual(['sticker_2']);
    expect(result.text).toBe('Pronto! ✨');
  });

  it('describes the attached assets to the model on every turn', async () => {
    const { agent, assets, model } = setup([[assistantMessage('Qual o estilo?')]]);
    await attach(assets, 'image', 'photo:blue');

    await agent.runTurn({ sender, userText: 'oi', newAssetIds: ['image_1'] });

    const input = JSON.stringify(model.calls[0]?.request.input);
    expect(input).toContain('image_1 (image, sent by the user)');
    expect(input).toContain('New message from the user: \\"oi\\"');
  });
});
