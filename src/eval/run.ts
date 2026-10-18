import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../config.js';
import { loadMediaSpec } from '../sim/fixtures.js';
import { StubImageGenerator } from '../sim/stub-image-generator.js';
import { stickerConstraints } from '../sticker/normalize.js';
import { createServices, type Services } from '../services.js';
import type { AgentTurnResult } from '../agent/sticker-agent.js';

interface Expectation {
  tools?: string[];
  forbidden_tools?: string[];
  sticker?: boolean;
}

interface EvalTurn {
  text?: string;
  sticker?: string;
  photo?: string;
  expect: Expectation;
}

interface EvalCase {
  id: string;
  description: string;
  turns: EvalTurn[];
}

interface TurnReport {
  input: string;
  reply: string;
  tools: string[];
  stickerFiles: string[];
  failures: string[];
}

const useStubImages = process.argv.includes('--stub-images');
const casesPath = join(process.cwd(), 'evals', 'cases.json');
const cases = JSON.parse(await readFile(casesPath, 'utf8')) as EvalCase[];

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN ?? 'eval',
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID ?? 'eval',
  WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN ?? 'eval',
  DATABASE_PATH: ':memory:',
});

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const reportDir = join(process.cwd(), 'tmp', 'eval', runId);
await mkdir(reportDir, { recursive: true });

const services = createServices(config, {
  imageGenerator: useStubImages ? new StubImageGenerator() : undefined,
});

const results: Array<{ testCase: EvalCase; turns: TurnReport[]; passed: boolean }> = [];

for (const testCase of cases) {
  const sender = `eval-${testCase.id}`;
  const turns: TurnReport[] = [];

  for (const [index, turn] of testCase.turns.entries()) {
    const newAssetIds: string[] = [];
    if (turn.sticker) newAssetIds.push(await attach(services, sender, 'sticker', turn.sticker));
    if (turn.photo) newAssetIds.push(await attach(services, sender, 'image', turn.photo));

    const result = await services.agent.runTurn({
      sender,
      userText: turn.text ?? '',
      newAssetIds,
    });

    const failures = checkExpectation(turn.expect, result);
    const stickerFiles: string[] = [];
    for (const id of result.stickerIds) {
      const asset = services.assets.get(sender, id);
      if (!asset) continue;

      const path = join(reportDir, `${testCase.id}-turn${index + 1}-${id}.webp`);
      await writeFile(path, asset.data);
      stickerFiles.push(path);
      failures.push(...await checkStickerFormat(asset.data));
    }

    turns.push({
      input: describeTurnInput(turn),
      reply: result.text,
      tools: result.trace.map((entry) => entry.tool),
      stickerFiles,
      failures,
    });
  }

  results.push({
    testCase,
    turns,
    passed: turns.every((turn) => turn.failures.length === 0),
  });
}

const passedCount = results.filter((result) => result.passed).length;
const report = renderReport(runId, useStubImages, results, passedCount);
await writeFile(join(reportDir, 'report.md'), report);

console.log(`\nEval results: ${passedCount}/${results.length} passed.`);
for (const result of results) {
  console.log(`${result.passed ? 'PASS' : 'FAIL'}  ${result.testCase.id}`);
  for (const turn of result.turns) {
    for (const failure of turn.failures) console.log(`      - ${failure}`);
  }
}
console.log(`Report: ${join(reportDir, 'report.md')}`);

process.exitCode = passedCount === results.length ? 0 : 1;

async function attach(
  services: Services,
  sender: string,
  kind: 'sticker' | 'image',
  spec: string,
): Promise<string> {
  const media = await loadMediaSpec(spec);
  return services.assets.add(sender, {
    kind,
    origin: 'user',
    mimeType: media.mimeType,
    data: media.data,
  }).id;
}

function checkExpectation(expect: Expectation, result: AgentTurnResult): string[] {
  const failures: string[] = [];
  const toolNames = new Set(result.trace.map((entry) => entry.tool));

  for (const tool of expect.tools ?? []) {
    if (!toolNames.has(tool)) failures.push(`expected tool ${tool} to be called`);
  }
  for (const tool of expect.forbidden_tools ?? []) {
    if (toolNames.has(tool)) failures.push(`tool ${tool} should not be called`);
  }
  if (expect.sticker !== undefined && (result.stickerIds.length > 0) !== expect.sticker) {
    failures.push(expect.sticker ? 'expected a sticker to be sent' : 'expected no sticker to be sent');
  }

  return failures;
}

async function checkStickerFormat(data: Buffer): Promise<string[]> {
  const metadata = await sharp(data).metadata();
  const failures: string[] = [];
  if (metadata.format !== 'webp') failures.push(`sticker format is ${metadata.format}, expected webp`);
  if (metadata.width !== stickerConstraints.dimension || metadata.height !== stickerConstraints.dimension) {
    failures.push(`sticker is ${metadata.width}x${metadata.height}, expected 512x512`);
  }
  if (data.byteLength > stickerConstraints.maxBytes) failures.push('sticker exceeds 100 KB');
  return failures;
}

function describeTurnInput(turn: EvalTurn): string {
  return [
    turn.sticker ? `sticker ${turn.sticker}` : '',
    turn.photo ? `photo ${turn.photo}` : '',
    turn.text ? `text "${turn.text}"` : '',
  ].filter(Boolean).join(' + ');
}

function renderReport(
  id: string,
  stubImages: boolean,
  results: Array<{ testCase: EvalCase; turns: TurnReport[]; passed: boolean }>,
  passedCount: number,
): string {
  const lines = [
    `# Sticker Agent eval report ${id}`,
    '',
    `Images: ${stubImages ? 'stub (no provider calls)' : 'OpenRouter'}. Passed ${passedCount}/${results.length}.`,
    '',
  ];

  for (const result of results) {
    lines.push(`## ${result.testCase.id}: ${result.passed ? 'PASS' : 'FAIL'}`, '', result.testCase.description, '');
    result.turns.forEach((turn, index) => {
      lines.push(
        `**Turn ${index + 1}** — input: ${turn.input}`,
        `- Tools: ${turn.tools.length > 0 ? turn.tools.join(', ') : 'none'}`,
        `- Reply: ${turn.reply}`,
      );
      for (const file of turn.stickerFiles) lines.push(`- Sticker: ${file}`);
      for (const failure of turn.failures) lines.push(`- ❌ ${failure}`);
      lines.push('');
    });
  }

  return lines.join('\n');
}
