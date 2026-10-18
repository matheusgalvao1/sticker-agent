import { describe, expect, it, vi } from 'vitest';
import { OpenRouterImageGenerator } from '../../src/openrouter/image-generator.js';

const config = {
  apiKey: 'test-key',
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'openai/gpt-image-2.5-sunburst',
  siteUrl: 'https://sticker.example',
  appName: 'Sticker bot test',
};

function successfulResponse(bytes: string) {
  return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(bytes).toString('base64'), media_type: 'image/png' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OpenRouterImageGenerator', () => {
  it('sends every reference image to the dedicated OpenRouter Images API', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(successfulResponse('generated png'));
    const generator = new OpenRouterImageGenerator(config, fetcher);

    const image = await generator.generate({
      prompt: 'Make the cat wear cowboy hat.',
      references: [
        { data: Buffer.from('sticker png'), mimeType: 'image/png' },
        { data: Buffer.from('photo'), mimeType: 'image/jpeg' },
      ],
    });

    expect(image.toString()).toBe('generated png');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/images');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key' });

    const body = JSON.parse(String(init?.body)) as {
      model: string;
      input_references: Array<{ image_url: { url: string } }>;
      prompt: string;
      background: string;
    };
    expect(body.model).toBe('openai/gpt-image-2.5-sunburst');
    expect(body.input_references).toHaveLength(2);
    expect(body.input_references[0]?.image_url.url).toContain('data:image/png;base64,');
    expect(body.input_references[1]?.image_url.url).toContain('data:image/jpeg;base64,');
    expect(body.prompt).toContain('Make the cat wear cowboy hat.');
    expect(body.background).toBe('transparent');
  });

  it('omits input_references for text-only requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(successfulResponse('generated png'));
    const generator = new OpenRouterImageGenerator(config, fetcher);

    await generator.generate({ prompt: 'A sleepy panda.', references: [] });

    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('input_references');
    expect(String(body.prompt)).toContain('A sleepy panda.');
  });

  it('surfaces an OpenRouter API error without attempting to decode an image', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'model unavailable' } }), { status: 503 }),
    );
    const generator = new OpenRouterImageGenerator(config, fetcher);

    await expect(generator.generate({ prompt: 'test', references: [] })).rejects.toThrow('model unavailable');
  });
});
