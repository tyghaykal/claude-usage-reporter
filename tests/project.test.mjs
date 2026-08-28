import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveProject, gitRoot } from '../src/project.mjs';

const existing = (...paths) => (p) => paths.includes(p);

test('gitRoot finds the repository root by walking up', () => {
  assert.equal(gitRoot('/a/b/c', existing('/a/b/.git')), '/a/b');
  assert.equal(gitRoot('/a/b', existing('/a/b/.git')), '/a/b');
  assert.equal(gitRoot('/a/b/c', existing()), null);
});

test('deriveProject names the repository, else the directory', () => {
  assert.equal(deriveProject('/work/my-repo/src', existing('/work/my-repo/.git')), 'my-repo');
  assert.equal(deriveProject('/work/loose-dir', existing()), 'loose-dir');
});

test('deriveProject falls back to "unknown" without a usable path', () => {
  assert.equal(deriveProject('', existing()), 'unknown');
  assert.equal(deriveProject('/', existing()), 'unknown');
});
