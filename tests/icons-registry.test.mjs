import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ICON_NAMES } from '../src/shared/icons.js';

const VALID_ICONS = new Set(ICON_NAMES);

function collectJsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      files.push(...collectJsFiles(full));
    } else if (entry.endsWith('.js') && !entry.endsWith('.test.js')) {
      files.push(full);
    }
  }
  return files;
}

test('all data-icon attributes in index.html are registered in ICON_NAMES', () => {
  const html = readFileSync(join(import.meta.dirname, '../src/index.html'), 'utf8');
  const matches = [...html.matchAll(/data-icon="([^"]+)"/g)];
  const missing = [];
  for (const m of matches) {
    const name = m[1];
    if (!VALID_ICONS.has(name)) {
      missing.push(name);
    }
  }
  assert.deepEqual(missing, [], `Found unregistered data-icon names in index.html: ${missing.join(', ')}`);
});

test('all literal icon("...") calls in src/ are registered in ICON_NAMES', () => {
  const srcDir = join(import.meta.dirname, '../src');
  const files = collectJsFiles(srcDir);
  const missing = [];

  for (const file of files) {
    const code = readFileSync(file, 'utf8');
    // 匹配 icon('name' 或 icon("name"
    const matches = [...code.matchAll(/\bicon\(\s*['"]([a-zA-Z0-9_-]+)['"]/g)];
    for (const m of matches) {
      const name = m[1];
      if (!VALID_ICONS.has(name)) {
        missing.push({ file: file.slice(srcDir.length), name });
      }
    }
  }

  assert.deepEqual(missing, [], `Found unregistered icon(...) calls in src/: ${JSON.stringify(missing)}`);
});
