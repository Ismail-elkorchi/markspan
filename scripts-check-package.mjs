import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('./', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('./package.json', root), 'utf8'));
const lock = JSON.parse(await readFile(new URL('./package-lock.json', root), 'utf8'));
const jsr = JSON.parse(await readFile(new URL('./jsr.json', root), 'utf8'));
assert.equal(pkg.name, 'markspan');
assert.equal(jsr.name, '@ismail-elkorchi/markspan');
assert.equal(jsr.version, pkg.version);
assert.equal(lock.lockfileVersion, 3);
assert.equal(lock.packages[''].version, pkg.version);
assert.equal(pkg.dependencies, undefined, 'published package must have zero runtime dependencies');
assert.equal(lock.packages[''].dependencies, undefined, 'lockfile must have zero root runtime dependencies');
for (const [name, version] of Object.entries(pkg.devDependencies)) {
  assert.match(version, /^\d+\.\d+\.\d+$/u, `${name} must use an exact version`);
}
const packageManager = /^npm@(\d+\.\d+\.\d+)$/u.exec(pkg.packageManager);
assert(packageManager, 'packageManager must pin an exact npm release');
const activePackageManager = /^npm\/(\d+\.\d+\.\d+)/u.exec(process.env['npm_config_user_agent'] ?? '');
if (activePackageManager !== null) assert.equal(activePackageManager[1], packageManager[1]);
assert.equal(pkg.sideEffects, false);
assert.equal(pkg.publishConfig.provenance, true);
assert.deepEqual(Object.keys(jsr.exports), Object.keys(pkg.exports));
for (const path of Object.values(jsr.exports)) {
  assert.match(path, /^\.\/src\/[a-z-]+\.ts$/u);
  await access(new URL(path, root));
}

for (const path of [
  'dist/mod.js',
  'dist/mod.d.ts',
  'dist/model.js',
  'dist/source.js',
  'dist/analysis.js',
  'dist/edit.js',
  'dist/syntax.js',
  'dist/tree-index.js'
]) await access(new URL(`./${path}`, root));

const api = await import(new URL('./dist/mod.js', root));
for (const name of [
  'parseMarkdown',
  'walkMarkdown',
  'extractMarkdownText',
  'collectMarkdownSyntaxTokens',
  'createMarkdownTreeIndex',
  'applyMarkdownTextEdits',
  'createMarkdownDocumentSession'
]) assert.equal(typeof api[name], 'function', `${name} must be exported`);

async function javascriptFiles(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await javascriptFiles(path));
    else if (extname(entry.name) === '.js') paths.push(path);
  }
  return paths;
}

for (const path of await javascriptFiles(join(fileURLToPath(root), 'dist'))) {
  const source = await readFile(path, 'utf8');
  assert.doesNotMatch(source, /from ['"]node:/u, `${path} must remain runtime-neutral`);
}

console.log('package surface verified');
