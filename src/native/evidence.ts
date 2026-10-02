import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

type EvidenceItem = { name: string; path: string };
type EvidenceContext = { directory: string; test: unknown; items: EvidenceItem[] };
let current: EvidenceContext | undefined;

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100) || 'test';
}

export function beginEvidence(runDirectory: string, test: { title: string; parent?: string; file?: string }) {
  const directory = path.join(runDirectory, 'evidence', `${safeName(test.title)}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  current = { directory, test, items: [] };
}

export function display(data: string, name = 'observation'): void {
  if (!current) throw new Error('Evidence requires the Maat WDIO beforeTest hook.');
  const filename = `${String(current.items.length + 1).padStart(3, '0')}-${safeName(name)}.png`;
  const output = path.join(current.directory, filename);
  writeFileSync(output, Buffer.from(data, 'base64'));
  current.items.push({ name, path: filename });
}

export const evidence = {
  async screenshot(name = 'observation'): Promise<void> {
    const { browser } = await import('@wdio/globals');
    display(await browser.takeScreenshot(), name);
  },
};

export function finishEvidence(passed: boolean, screenshotError?: string): void {
  if (!current) return;
  const context = current;
  current = undefined;
  writeFileSync(path.join(context.directory, 'evidence.json'), JSON.stringify({
    test: context.test, passed, screenshotError, items: context.items,
  }, null, 2) + '\n');
}
