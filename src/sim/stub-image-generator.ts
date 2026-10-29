import sharp from 'sharp';
import type { ImageGeneration, ImageGenerationRequest, ImageGenerator } from '../openrouter/image-generator.js';
import { SAMPLE_COLORS } from './fixtures.js';

/** Returns a placeholder image without calling a provider. Records every request. */
export class StubImageGenerator implements ImageGenerator {
  readonly calls: ImageGenerationRequest[] = [];

  async generate(request: ImageGenerationRequest): Promise<ImageGeneration> {
    this.calls.push(request);
    const colors = Object.values(SAMPLE_COLORS);
    const fill = colors[(this.calls.length - 1) % colors.length] ?? '#888888';
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">',
      `<circle cx="512" cy="512" r="380" fill="${fill}" stroke="#ffffff" stroke-width="32"/>`,
      '</svg>',
    ].join('');
    return { data: await sharp(Buffer.from(svg)).png().toBuffer() };
  }
}
