import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execute = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), 'markspan-release-'));
const firstDirectory = join(temporary, 'first');
const secondDirectory = join(temporary, 'second');

async function pack(destination) {
  const { stdout } = await execute('npm', [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    destination
  ], { cwd: new URL('../', import.meta.url) });
  const result = JSON.parse(stdout)[0];
  assert(result?.filename);
  assert.equal(result.name, 'markspan');
  return {
    bytes: await readFile(join(destination, result.filename)),
    files: result.files.map((entry) => entry.path).sort()
  };
}

try {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);
  const first = await pack(firstDirectory);
  const second = await pack(secondDirectory);
  assert.deepEqual(first.files, second.files);
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  assert.equal(digest(first.bytes), digest(second.bytes), 'npm package bytes are not reproducible');
  assert(first.files.includes('dist/mod.js'));
  assert(first.files.includes('dist/mod.d.ts'));
  assert(first.files.includes('fixtures/conformance-matrix.json'));
  console.log(`release artifact reproducible: sha256 ${digest(first.bytes)}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
