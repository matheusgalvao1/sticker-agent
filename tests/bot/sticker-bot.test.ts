import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTurnInput, AgentTurnRunner } from '../../src/agent/sticker-agent.js';
import { AssetStore } from '../../src/assets/store.js';
import { StickerBotService, type BotAccounts } from '../../src/bot/sticker-bot.js';
import type { Messenger } from '../../src/messaging.js';
import type { IncomingWhatsAppMessage } from '../../src/whatsapp/types.js';

const sender = '15551234567';

describe('StickerBotService', () => {
  let messenger: {
    downloadMedia: ReturnType<typeof vi.fn>;
    sendText: ReturnType<typeof vi.fn>;
    sendSticker: ReturnType<typeof vi.fn>;
  };
  let agent: {
    runTurn: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
  };
  let accounts: {
    getOrCreateUser: ReturnType<typeof vi.fn>;
  };
  let assets: AssetStore;
  let bot: StickerBotService;

  beforeEach(() => {
    assets = new AssetStore(60_000, { now: () => 0 });
    messenger = {
      downloadMedia: vi.fn(async () => ({ data: Buffer.from('photo'), mimeType: 'image/jpeg', filename: 'p.jpg' })),
      sendText: vi.fn(async () => undefined),
      sendSticker: vi.fn(async () => undefined),
    };
    agent = {
      runTurn: vi.fn(async (_input: AgentTurnInput) => ({ text: 'Tudo certo?', stickerIds: [], trace: [] })),
      reset: vi.fn(async () => undefined),
    };
    accounts = {
      getOrCreateUser: vi.fn(() => ({ user: { status: 'active' }, created: false })),
    };
    bot = new StickerBotService({
      assets,
      agent: agent as unknown as AgentTurnRunner,
      whatsapp: messenger as unknown as Messenger,
      accounts: accounts as unknown as BotAccounts,
    });
  });

  it('sends a welcome message the first time a number is seen', async () => {
    accounts.getOrCreateUser.mockReturnValueOnce({ user: { status: 'active' }, created: true });

    await bot.handleIncoming(message({ type: 'text', text: { body: 'oi' } }));

    expect(messenger.sendText).toHaveBeenNthCalledWith(1, sender, expect.stringContaining('Bem-vindo'));
  });

  it('does not repeat the welcome message on later messages', async () => {
    await bot.handleIncoming(message({ type: 'text', text: { body: 'oi' } }));

    expect(messenger.sendText).not.toHaveBeenCalledWith(sender, expect.stringContaining('Bem-vindo'));
  });

  it('passes a text message to the agent without any assets', async () => {
    await bot.handleIncoming(message({ type: 'text', text: { body: 'um gato laranja' } }));

    expect(agent.runTurn).toHaveBeenCalledWith({ sender, userText: 'um gato laranja', newAssetIds: [] });
    expect(messenger.sendText).toHaveBeenCalledWith(sender, 'Tudo certo?');
  });

  it('stores a received sticker and hands it to the agent with the message', async () => {
    messenger.downloadMedia.mockResolvedValueOnce({ data: await staticSticker(), mimeType: 'image/webp', filename: 's.webp' });

    await bot.handleIncoming(message({ type: 'sticker', sticker: { id: 'media-1' } }));

    expect(assets.get(sender, 'sticker_1')).toMatchObject({ kind: 'sticker', origin: 'user' });
    expect(agent.runTurn).toHaveBeenCalledWith({ sender, userText: '', newAssetIds: ['sticker_1'] });
  });

  it('uses a photo caption as the message text', async () => {
    await bot.handleIncoming(message({ type: 'image', image: { id: 'media-2', caption: 'faz ele rir' } }));

    expect(agent.runTurn).toHaveBeenCalledWith({ sender, userText: 'faz ele rir', newAssetIds: ['image_1'] });
  });

  it('sends only the text reply; stickers were delivered by the agent during the turn', async () => {
    agent.runTurn.mockImplementationOnce(async () => {
      const stored = assets.add(sender, { kind: 'sticker', origin: 'generated', mimeType: 'image/webp', data: Buffer.from('webp') });
      await (messenger.sendSticker as (to: string, data: Buffer) => Promise<unknown>)(sender, Buffer.from('webp'));
      return { text: 'Prontinho!', stickerIds: [stored.id], trace: [] };
    });
    await bot.handleIncoming(message({ type: 'text', text: { body: 'um cachorro' } }));

    expect(messenger.sendSticker).toHaveBeenCalledWith(sender, Buffer.from('webp'));
    const stickerOrder = messenger.sendSticker.mock.invocationCallOrder[0] ?? 0;
    const textOrder = messenger.sendText.mock.invocationCallOrder[0] ?? 0;
    expect(stickerOrder).toBeLessThan(textOrder);
    expect(messenger.sendText).toHaveBeenCalledWith(sender, 'Prontinho!');
  });

  it('rejects animated stickers without calling the agent', async () => {
    messenger.downloadMedia.mockResolvedValueOnce({ data: await animatedSticker(), mimeType: 'image/webp', filename: 'a.webp' });

    await bot.handleIncoming(message({ type: 'sticker', sticker: { id: 'media-3' } }));

    expect(agent.runTurn).not.toHaveBeenCalled();
    expect(messenger.sendText).toHaveBeenCalledWith(sender, expect.stringContaining('animados'));
  });

  it('sends the memory-expired notice before the turn when the context expired', async () => {
    const memory = { hasExpiredContext: vi.fn(() => true) };
    const botWithMemory = new StickerBotService({
      assets,
      agent: agent as unknown as AgentTurnRunner,
      whatsapp: messenger as unknown as Messenger,
      accounts: accounts as unknown as BotAccounts,
      memory,
    });

    await botWithMemory.handleIncoming(message({ type: 'text', text: { body: 'um gato' } }));

    expect(memory.hasExpiredContext).toHaveBeenCalledWith(sender);
    expect(messenger.sendText).toHaveBeenCalledWith(sender, expect.stringContaining('conversa novinha'));
    const noticeOrder = messenger.sendText.mock.invocationCallOrder[0] ?? 0;
    const turnOrder = agent.runTurn.mock.invocationCallOrder[0] ?? 0;
    expect(noticeOrder).toBeLessThan(turnOrder);
  });

  it('stays silent about expired context when there was none', async () => {
    const memory = { hasExpiredContext: vi.fn(() => false) };
    const botWithMemory = new StickerBotService({
      assets,
      agent: agent as unknown as AgentTurnRunner,
      whatsapp: messenger as unknown as Messenger,
      accounts: accounts as unknown as BotAccounts,
      memory,
    });

    await botWithMemory.handleIncoming(message({ type: 'text', text: { body: 'um gato' } }));

    expect(memory.hasExpiredContext).toHaveBeenCalledWith(sender);
    expect(messenger.sendText).not.toHaveBeenCalledWith(sender, expect.stringContaining('conversa novinha'));
  });

  it('resets the conversation on /new', async () => {
    assets.add(sender, { kind: 'image', origin: 'user', mimeType: 'image/jpeg', data: Buffer.from('x') });

    await bot.handleIncoming(message({ type: 'text', text: { body: '/new' } }));

    expect(assets.list(sender)).toEqual([]);
    expect(agent.reset).toHaveBeenCalledWith(sender);
    expect(agent.runTurn).not.toHaveBeenCalled();
    expect(messenger.sendText).toHaveBeenCalledWith(sender, 'Começamos do zero ✨ Me manda o que quiser criar.');
  });

  it('answers /help without running the agent', async () => {
    await bot.handleIncoming(message({ type: 'text', text: { body: '/help' } }));

    expect(agent.runTurn).not.toHaveBeenCalled();
    expect(messenger.sendText).toHaveBeenCalledWith(sender, expect.stringContaining('stickers'));
  });

  it('does not let a suspended account use the bot', async () => {
    accounts.getOrCreateUser.mockReturnValue({ user: { status: 'suspended' }, created: false });

    await bot.handleIncoming(message({ type: 'text', text: { body: 'um gato' } }));

    expect(agent.runTurn).not.toHaveBeenCalled();
    expect(messenger.sendText).toHaveBeenCalledWith(sender, expect.stringContaining('suspensa'));
  });

  it('explains unsupported message types without calling the agent', async () => {
    await bot.handleIncoming(message({ type: 'video' }));

    expect(agent.runTurn).not.toHaveBeenCalled();
    expect(messenger.sendText).toHaveBeenCalledWith(sender, expect.stringContaining('tipo de mensagem'));
  });

  it('replies with a retry prompt when the agent fails', async () => {
    agent.runTurn.mockRejectedValueOnce(new Error('model down'));

    await bot.handleIncoming(message({ type: 'text', text: { body: 'um gato' } }));

    expect(messenger.sendText).toHaveBeenCalledWith(sender, expect.stringContaining('tentar de novo'));
  });

  it('asks the user to resend when media cannot be downloaded', async () => {
    messenger.downloadMedia.mockRejectedValueOnce(new Error('expired'));

    await bot.handleIncoming(message({ type: 'image', image: { id: 'media-4' } }));

    expect(agent.runTurn).not.toHaveBeenCalled();
    expect(messenger.sendText).toHaveBeenCalledWith(sender, expect.stringContaining('enviar de novo'));
  });
});

function message(
  overrides: Partial<IncomingWhatsAppMessage> & Pick<IncomingWhatsAppMessage, 'type'>,
): IncomingWhatsAppMessage {
  return {
    id: `wamid-${Math.random().toString(36).slice(2)}`,
    from: sender,
    ...overrides,
  };
}

async function staticSticker(): Promise<Buffer> {
  return sharp(Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><circle cx="256" cy="256" r="200" fill="#e53935"/></svg>',
  )).webp().toBuffer();
}

async function animatedSticker(): Promise<Buffer> {
  const frame = (red: number) =>
    sharp({ create: { width: 64, height: 64, channels: 4, background: { r: red, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  return sharp([await frame(255), await frame(0)], { join: { animated: true } }).webp().toBuffer();
}
