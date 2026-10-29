import type { AgentTurnRunner } from '../agent/sticker-agent.js';
import type { AssetKind, AssetStore } from '../assets/store.js';
import type { Messenger } from '../messaging.js';
import { isAnimatedSticker } from '../sticker/normalize.js';
import type { IncomingWhatsAppMessage } from '../whatsapp/types.js';

export interface BotAccounts {
  getOrCreateUser(whatsappId: string): { user: { status: string }; created: boolean };
}

export interface StickerBotDependencies {
  assets: AssetStore;
  agent: AgentTurnRunner;
  whatsapp: Messenger;
  accounts: BotAccounts;
}

export const GENERATING_TEXT = 'Gerando seu sticker… 🎨';

const WELCOME_TEXT = [
  '👋 Bem-vindo ao Sticker Agent!',
  'Me mande uma descrição, uma foto ou um sticker, com ou sem instruções. Eu crio o sticker e envio para você.',
  'Se faltar alguma informação, eu pergunto. Use /new para começar uma conversa nova.',
].join('\n');

const HELP_TEXT = [
  'Eu crio e transformo stickers para o WhatsApp.',
  'Me mande uma descrição, uma foto ou um sticker, com ou sem instruções. Se faltar alguma informação, eu pergunto.',
  'Use /new para começar uma conversa nova.',
].join('\n');

export interface IngestedMessage {
  text: string;
  newAssetIds: string[];
  skip: boolean;
}

export class StickerBotService {
  constructor(private readonly dependencies: StickerBotDependencies) {}

  /** Compatibility entry point: ingest one message and run its turn immediately. */
  async handleIncoming(message: IncomingWhatsAppMessage): Promise<void> {
    const ingested = await this.ingestMessage(message);
    if (ingested.skip) return;
    await this.runBatch(message.from, [ingested.text], ingested.newAssetIds);
  }

  /**
   * Per-message work done on arrival: account, welcome, commands, and media download.
   * skip means the message was fully handled here and no agent turn is needed.
   */
  async ingestMessage(message: IncomingWhatsAppMessage): Promise<IngestedMessage> {
    const sender = message.from;
    const text = messageText(message);
    const command = message.type === 'text' ? parseCommand(text) : null;
    const { whatsapp, accounts } = this.dependencies;
    const skip: IngestedMessage = { text: '', newAssetIds: [], skip: true };

    if (command === 'help') {
      await whatsapp.sendText(sender, HELP_TEXT);
      return skip;
    }

    const { user, created } = accounts.getOrCreateUser(sender);
    if (created) await whatsapp.sendText(sender, WELCOME_TEXT);

    if (user.status !== 'active') {
      await whatsapp.sendText(sender, 'Sua conta está suspensa. Fale com o administrador.');
      return skip;
    }

    if (command === 'new') {
      this.dependencies.assets.clear(sender);
      await this.dependencies.agent.reset(sender);
      await whatsapp.sendText(sender, 'Conversa reiniciada. Me mande uma descrição, uma foto ou um sticker.');
      return skip;
    }

    const newAssetIds: string[] = [];

    if (message.type === 'sticker' && message.sticker?.id) {
      const id = await this.ingest(sender, message.sticker.id, 'sticker');
      if (!id) return skip;
      newAssetIds.push(id);
    } else if (message.type === 'image' && message.image?.id) {
      const id = await this.ingest(sender, message.image.id, 'image');
      if (!id) return skip;
      newAssetIds.push(id);
    } else if (message.type === 'text') {
      if (!text) return skip;
    } else {
      await whatsapp.sendText(
        sender,
        'Ainda não consigo usar esse tipo de mensagem. Envie texto, uma foto ou um sticker.',
      );
      return skip;
    }

    return { text, newAssetIds, skip: false };
  }

  /** One agent turn for a burst of messages, then delivery of the final text. The agent sends its own stickers. */
  async runBatch(sender: string, texts: string[], newAssetIds: string[]): Promise<void> {
    const userText = texts.filter((text) => text.length > 0).join('\n');

    let turn;
    try {
      turn = await this.dependencies.agent.runTurn({ sender, userText, newAssetIds });
    } catch {
      await this.dependencies.whatsapp.sendText(sender, 'Tive um problema ao processar sua mensagem. Pode tentar de novo?');
      return;
    }

    if (turn.text) await this.dependencies.whatsapp.sendText(sender, turn.text);
  }

  private async ingest(sender: string, mediaId: string, kind: AssetKind): Promise<string | null> {
    try {
      const media = await this.dependencies.whatsapp.downloadMedia(mediaId);
      if (kind === 'sticker' && await isAnimatedSticker(media.data)) {
        await this.dependencies.whatsapp.sendText(
          sender,
          'Stickers animados ainda não são suportados. Envie um estático ou uma foto.',
        );
        return null;
      }
      return this.dependencies.assets.add(sender, {
        kind,
        origin: 'user',
        mimeType: media.mimeType,
        data: media.data,
      }).id;
    } catch {
      await this.dependencies.whatsapp.sendText(sender, 'Não consegui ler esse arquivo. Pode enviar de novo?');
      return null;
    }
  }
}

function messageText(message: IncomingWhatsAppMessage): string {
  if (message.type === 'text') return message.text?.body?.trim() ?? '';
  if (message.type === 'image') return message.image?.caption?.trim() ?? '';
  return '';
}

function parseCommand(text: string): 'new' | 'help' | null {
  const normalized = text.trim().toLowerCase().replace(/^\//, '');
  if (normalized === 'new' || normalized === 'cancel') return 'new';
  if (normalized === 'help' || normalized === 'ajuda') return 'help';
  return null;
}
