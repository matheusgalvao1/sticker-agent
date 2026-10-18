export interface ImageReference {
  data: Buffer;
  mimeType: string;
}

export interface ImageGenerationRequest {
  prompt: string;
  references: ImageReference[];
}

export interface ImageGenerator {
  generate(request: ImageGenerationRequest): Promise<Buffer>;
}

interface OpenRouterImageResponse {
  data?: Array<{
    b64_json?: string;
    media_type?: string;
  }>;
  error?: {
    message?: string;
  };
}

export interface OpenRouterImageGeneratorConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  siteUrl: string;
  appName: string;
}

const STICKER_RULES = [
  'Create one polished, static sticker. Do not create a sheet, mockup, phone, chat UI, or multiple panels.',
  'Keep the background transparent and add a clear white die-cut outline around the main subject.',
  'Do not add unrelated text.',
].join('\n');

export class OpenRouterImageGenerator implements ImageGenerator {
  constructor(
    private readonly config: OpenRouterImageGeneratorConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async generate(request: ImageGenerationRequest): Promise<Buffer> {
    const response = await this.fetcher(`${this.config.baseUrl}/images`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': this.config.siteUrl,
        'X-OpenRouter-Title': this.config.appName,
      },
      body: JSON.stringify({
        model: this.config.model,
        prompt: [STICKER_RULES, request.prompt].join('\n\n'),
        ...(request.references.length > 0
          ? { input_references: request.references.map(imageReference) }
          : {}),
        size: '1024x1024',
        quality: 'high',
        background: 'transparent',
        output_format: 'png',
        n: 1,
      }),
      signal: AbortSignal.timeout(240_000),
    });

    const payload = await readImageResponse(response);
    const base64 = payload.data?.[0]?.b64_json;
    if (!base64) {
      throw new Error('OpenRouter returned no generated image data.');
    }

    const bytes = Buffer.from(base64, 'base64');
    if (bytes.byteLength === 0) throw new Error('OpenRouter returned an empty image.');
    return bytes;
  }
}

function imageReference(reference: ImageReference) {
  return {
    type: 'image_url',
    image_url: {
      url: `data:${reference.mimeType};base64,${reference.data.toString('base64')}`,
    },
  } as const;
}

async function readImageResponse(response: Response): Promise<OpenRouterImageResponse> {
  const text = await response.text();
  let payload: unknown;

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`OpenRouter Images API returned invalid JSON (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload !== null && 'error' in payload &&
      typeof payload.error === 'object' && payload.error !== null && 'message' in payload.error &&
      typeof payload.error.message === 'string'
        ? payload.error.message.slice(0, 400)
        : 'the upstream service returned an error';
    throw new Error(`OpenRouter image generation failed (HTTP ${response.status}): ${message}`);
  }

  return payload as OpenRouterImageResponse;
}
