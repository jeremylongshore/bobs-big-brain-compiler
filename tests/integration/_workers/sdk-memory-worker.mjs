import { stat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const [modulePath, root] = process.argv.slice(2);
assert(root?.startsWith(join(tmpdir(), 'bbb-compiler-sdk-memory-root-')));
assert.equal(resolve(root), root);
globalThis.fetch = async () => {
  throw new Error('External requests forbidden in memory fixture');
};
const { BetaLocalFilesystemMemoryTool } = await import(pathToFileURL(modulePath).href);
const prior = process.umask(0);
const checks = [];
const mode = async (name, path, expected) => {
  const actual = (await stat(path)).mode & 0o777;
  checks.push({
    name,
    expected: expected.toString(8),
    actual: actual.toString(8),
    pass: actual === expected,
  });
};
try {
  const tool = await BetaLocalFilesystemMemoryTool.init(root);
  await mode('fresh memory root', join(root, 'memories'), 0o700);
  await tool.create({
    command: 'create',
    path: '/memories/nested/note.txt',
    file_text: 'fixture original',
  });
  await mode('create intermediate directory', join(root, 'memories/nested'), 0o700);
  await mode('created file', join(root, 'memories/nested/note.txt'), 0o600);
  assert.equal(await readFile(join(root, 'memories/nested/note.txt'), 'utf8'), 'fixture original');
  await tool.str_replace({
    command: 'str_replace',
    path: '/memories/nested/note.txt',
    old_str: 'original',
    new_str: 'replacement',
  });
  assert.equal(
    await readFile(join(root, 'memories/nested/note.txt'), 'utf8'),
    'fixture replacement',
  );
  await mode('atomic replacement file', join(root, 'memories/nested/note.txt'), 0o600);
  assert.deepEqual(await readdir(join(root, 'memories/nested')), ['note.txt']);
  await tool.rename({
    command: 'rename',
    old_path: '/memories/nested/note.txt',
    new_path: '/memories/renamed/note.txt',
  });
  await mode('rename destination directory', join(root, 'memories/renamed'), 0o700);
  assert.equal(
    await readFile(join(root, 'memories/renamed/note.txt'), 'utf8'),
    'fixture replacement',
  );
  console.log(JSON.stringify({ checks, functionalControlsPassed: true, childOnlyUmask: true }));
  process.exitCode = checks.every((c) => c.pass) ? 0 : 1;
} finally {
  process.umask(prior);
}
