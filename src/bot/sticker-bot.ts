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

export class StickerBotService {
  constructor(private readonly dependencies: StickerBotDependencies) {}

  async handleIncoming(message: IncomingWhatsAppMessage): Promise<void> {
    const sender = message.from;
    const text = messageText(message);
    const command = message.type === 'text' ? parseCommand(text) : null;
    const { whatsapp, accounts } = this.dependencies;

    if (command === 'help') {
      await whatsapp.sendText(sender, HELP_TEXT);
      return;
    }

    const { user, created } = accounts.getOrCreateUser(sender);
    if (created) await whatsapp.sendText(sender, WELCOME_TEXT);

    if (user.status !== 'active') {
      await whatsapp.sendText(sender, 'Sua conta está suspensa. Fale com o administrador.');
      return;
    }

    if (command === 'new') {
      this.dependencies.assets.clear(sender);
      await this.dependencies.agent.reset(sender);
      await whatsapp.sendText(sender, 'Conversa reiniciada. Me mande uma descrição, uma foto ou um sticker.');
      return;
    }

    const newAssetIds: string[] = [];

    if (message.type === 'sticker' && message.sticker?.id) {
      const id = await this.ingest(sender, message.sticker.id, 'sticker');
      if (!id) return;
      newAssetIds.push(id);
    } else if (message.type === 'image' && message.image?.id) {
      const id = await this.ingest(sender, message.image.id, 'image');
      if (!id) return;
      newAssetIds.push(id);
    } else if (message.type === 'text') {
      if (!text) return;
    } else {
      await whatsapp.sendText(
        sender,
        'Ainda não consigo usar esse tipo de mensagem. Envie texto, uma foto ou um sticker.',
      );
      return;
    }

    let turn;
    try {
      turn = await this.dependencies.agent.runTurn({ sender, userText: text, newAssetIds });
    } catch {
      await whatsapp.sendText(sender, 'Tive um problema ao processar sua mensagem. Pode tentar de novo?');
      return;
    }

    for (const id of turn.stickerIds) {
      const asset = this.dependencies.assets.get(sender, id);
      if (!asset) continue;
      try {
        await whatsapp.sendSticker(sender, asset.data);
      } catch {
        await whatsapp.sendText(sender, 'Criei o sticker, mas não consegui enviá-lo. Pode pedir de novo?');
      }
    }

    if (turn.text) await whatsapp.sendText(sender, turn.text);
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
