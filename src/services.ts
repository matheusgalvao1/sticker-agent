import type { ModelProvider } from '@openai/agents';
import { DailyGenerationLimit } from './agent/budget.js';
import { InMemoryAgentSessionStore, StickerAgent } from './agent/sticker-agent.js';
import { AccountService } from './accounts/service.js';
import { AssetStore } from './assets/store.js';
import { GENERATING_TEXT, StickerBotService } from './bot/sticker-bot.js';
import { systemClock, type Clock } from './clock.js';
import type { AppConfig } from './config.js';
import { openDatabase, type Db } from './db/database.js';
import type { Messenger } from './messaging.js';
import { OpenRouterImageGenerator, type ImageGenerator } from './openrouter/image-generator.js';
import { WhatsAppCloudClient } from './whatsapp/client.js';

export interface ServiceOverrides {
  messenger?: Messenger | undefined;
  imageGenerator?: ImageGenerator | undefined;
  modelProvider?: ModelProvider | undefined;
  clock?: Clock | undefined;
}

export interface Services {
  bot: StickerBotService;
  agent: StickerAgent;
  assets: AssetStore;
  accounts: AccountService;
  db: Db;
}

/** Wires the application together. Tests and the local harness pass fakes as overrides. */
export function createServices(config: AppConfig, overrides: ServiceOverrides = {}): Services {
  const clock = overrides.clock ?? systemClock;
  const db = openDatabase(config.databasePath);
  const messenger = overrides.messenger ?? new WhatsAppCloudClient({
    accessToken: config.whatsapp.accessToken,
    phoneNumberId: config.whatsapp.phoneNumberId,
    graphApiVersion: config.whatsapp.graphApiVersion,
    maxInputImageBytes: config.maxInputImageBytes,
  });
  const imageGenerator = overrides.imageGenerator ?? new OpenRouterImageGenerator({
    apiKey: config.openRouter.apiKey,
    baseUrl: config.openRouter.baseUrl,
    model: config.openRouter.imageModel,
    siteUrl: config.openRouter.siteUrl,
    appName: config.openRouter.appName,
  });

  const accounts = new AccountService(db, clock);
  const assets = new AssetStore(config.memoryTtlMs, clock);
  const agent = new StickerAgent({
    config: {
      apiKey: config.openRouter.apiKey,
      baseUrl: config.openRouter.baseUrl,
      agentModel: config.openRouter.agentModel,
      siteUrl: config.openRouter.siteUrl,
      appName: config.openRouter.appName,
    },
    imageGenerator,
    assets,
    sessions: new InMemoryAgentSessionStore(config.memoryTtlMs, clock),
    budget: new DailyGenerationLimit(db, config.dailyGenerationLimit, clock),
    notifyGenerationStart: async (sender) => {
      await messenger.sendText(sender, GENERATING_TEXT);
    },
    modelProvider: overrides.modelProvider,
  });
  const bot = new StickerBotService({ assets, agent, whatsapp: messenger, accounts });

  return { bot, agent, assets, accounts, db };
}
