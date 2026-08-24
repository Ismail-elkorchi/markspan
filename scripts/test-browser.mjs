import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const directory = await mkdtemp(join(tmpdir(), 'markspan-browser-'));
const bundle = join(directory, 'test.js');
try {
  await build({
    entryPoints: [new URL('./browser-entry.mjs', import.meta.url).pathname],
    outfile: bundle,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2023']
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><meta charset="utf-8"><title>parser test</title>');
    await page.addScriptTag({ path: bundle });
    const result = await page.evaluate(() => globalThis.__MARKSPAN_BROWSER_RESULT__);
    assert.deepEqual(result, {
      heading: 1,
      strong: 1,
      tasks: 1,
      links: 1,
      source: '# Browser\n\n- [x] **works**\n\nhttps://example.com'
    });
  } finally {
    await browser.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log('Markspan browser runtime verified');
