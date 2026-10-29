import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),

  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_AGENT_MODEL: z.string().min(1).default('openai/gpt-6-luna'),
  OPENROUTER_IMAGE_MODEL: z.string().min(1).default('openai/gpt-image-2.5-sunburst'),
  OPENROUTER_IMAGE_QUALITY: z.enum(['auto', 'low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  OPENROUTER_SITE_URL: z.string().url().default('http://localhost:3000'),
  OPENROUTER_APP_NAME: z.string().default('WhatsApp Sticker Agent'),

  WHATSAPP_ACCESS_TOKEN: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  WHATSAPP_APP_SECRET: z.string().optional().default(''),
  WHATSAPP_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v25.0'),
  WHATSAPP_ALLOWED_NUMBERS: z.string().default(''),

  MEMORY_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  DAILY_GENERATION_LIMIT: z.coerce.number().int().positive().default(20),
  BATCH_WINDOW_SECONDS: z.coerce.number().int().min(0).max(120).default(5),
  MAX_INPUT_IMAGE_BYTES: z.coerce.number().int().positive().default(10_000_000),

  DATABASE_PATH: z.string().min(1).default('.data/sticker-agent.db'),
});

export interface AppConfig {
  environment: 'development' | 'test' | 'production';
  host: string;
  port: number;
  openRouter: {
    apiKey: string;
    baseUrl: string;
    agentModel: string;
    imageModel: string;
    imageQuality: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    siteUrl: string;
    appName: string;
  };
  whatsapp: {
    accessToken: string;
    phoneNumberId: string;
    verifyToken: string;
    appSecret: string;
    graphApiVersion: string;
    allowedNumbers: ReadonlySet<string>;
  };
  memoryTtlMs: number;
  dailyGenerationLimit: number;
  batchWindowMs: number;
  maxInputImageBytes: number;
  databasePath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const values = parsed.data;
  const allowedNumbers = new Set(
    values.WHATSAPP_ALLOWED_NUMBERS.split(',')
      .map(normalizePhoneNumber)
      .filter((number) => number.length > 0),
  );

  if (values.NODE_ENV === 'production') {
    if (!values.WHATSAPP_APP_SECRET) {
      throw new Error('WHATSAPP_APP_SECRET is required in production.');
    }
    if (allowedNumbers.size === 0) {
      throw new Error('Set WHATSAPP_ALLOWED_NUMBERS before exposing the bot in production.');
    }
  }

  return {
    environment: values.NODE_ENV,
    host: values.HOST,
    port: values.PORT,
    openRouter: {
      apiKey: values.OPENROUTER_API_KEY,
      baseUrl: values.OPENROUTER_BASE_URL.replace(/\/$/, ''),
      agentModel: values.OPENROUTER_AGENT_MODEL,
      imageModel: values.OPENROUTER_IMAGE_MODEL,
      imageQuality: values.OPENROUTER_IMAGE_QUALITY,
      siteUrl: values.OPENROUTER_SITE_URL,
      appName: values.OPENROUTER_APP_NAME,
    },
    whatsapp: {
      accessToken: values.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: values.WHATSAPP_PHONE_NUMBER_ID,
      verifyToken: values.WHATSAPP_VERIFY_TOKEN,
      appSecret: values.WHATSAPP_APP_SECRET,
      graphApiVersion: values.WHATSAPP_GRAPH_API_VERSION,
      allowedNumbers,
    },
    memoryTtlMs: values.MEMORY_TTL_MINUTES * 60_000,
    dailyGenerationLimit: values.DAILY_GENERATION_LIMIT,
    batchWindowMs: values.BATCH_WINDOW_SECONDS * 1_000,
    maxInputImageBytes: values.MAX_INPUT_IMAGE_BYTES,
    databasePath: values.DATABASE_PATH,
  };
}

/**
 * Digits only. WhatsApp sometimes reports Brazilian mobile numbers without the extra leading 9
 * (12 digits), while the recipient list uses the 13-digit form. Both map to the 13-digit form.
 */
export function normalizePhoneNumber(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, '');
  const brazilianMobile = /^55(\d{2})([6-9]\d{7})$/.exec(digits);
  if (brazilianMobile) return `55${brazilianMobile[1]}9${brazilianMobile[2]}`;
  return digits;
}
