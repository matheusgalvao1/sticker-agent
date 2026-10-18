import { z } from 'zod';

const mediaObjectSchema = z.object({
  id: z.string().min(1),
  mime_type: z.string().optional(),
  caption: z.string().optional(),
}).passthrough();

export const incomingWhatsAppMessageSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  timestamp: z.string().optional(),
  type: z.string().min(1),
  text: z.object({ body: z.string() }).optional(),
  image: mediaObjectSchema.optional(),
  sticker: mediaObjectSchema.optional(),
}).passthrough();

export type IncomingWhatsAppMessage = z.infer<typeof incomingWhatsAppMessageSchema>;

const webhookPayloadSchema = z.object({
  entry: z.array(z.object({
    changes: z.array(z.object({
      value: z.object({
        messages: z.array(incomingWhatsAppMessageSchema).optional(),
      }).passthrough(),
    }).passthrough()),
  }).passthrough()),
}).passthrough();

export function extractIncomingMessages(payload: unknown): IncomingWhatsAppMessage[] {
  const parsed = webhookPayloadSchema.parse(payload);
  return parsed.entry.flatMap((entry) =>
    entry.changes.flatMap((change) => change.value.messages ?? []),
  );
}
