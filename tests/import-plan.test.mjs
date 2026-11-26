import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveConflictDecision,
  selectWritableRows,
  countOverwrites,
  buildImportDecisions,
} from '../src/shared/import-plan.js';

const fixture4 = [
  { key: 'k-conflict', kind: 'conflict', name: 'cache-prod-02' },
  { key: 'k-add-1', kind: 'add', name: 'cache-prod-01' },
  { key: 'k-add-2', kind: 'add', name: 'db-replica-3' },
  { key: 'k-add-3', kind: 'add', name: 'jump-01' },
];

test('冲突行默认跳过时，不计入可写入行（4 台含 1 冲突 → 3 台）', () => {
  const opts = { excluded: new Set(), decision: 'skip', perRow: {} };
  const writable = selectWritableRows(fixture4, opts);
  assert.equal(writable.length, 3);
  assert.deepEqual(writable.map((r) => r.key), ['k-add-1', 'k-add-2', 'k-add-3']);
  assert.equal(countOverwrites(fixture4, opts), 0);
  assert.deepEqual(buildImportDecisions(fixture4, opts), { 'k-conflict': 'skip' });
});

test('全局冲突策略切到覆盖时，可写入行回到 4 台且覆盖计数为 1', () => {
  const opts = { excluded: new Set(), decision: 'overwrite', perRow: {} };
  assert.equal(selectWritableRows(fixture4, opts).length, 4);
  assert.equal(countOverwrites(fixture4, opts), 1);
  assert.deepEqual(buildImportDecisions(fixture4, opts), { 'k-conflict': 'overwrite' });
});

test('逐行处置优先于全局策略（双向覆盖与跳过）', () => {
  const skipGlobalRowOverwrite = {
    excluded: new Set(),
    decision: 'skip',
    perRow: { 'k-conflict': 'overwrite' },
  };
  assert.equal(effectiveConflictDecision(fixture4[0], skipGlobalRowOverwrite), 'overwrite');
  assert.equal(selectWritableRows(fixture4, skipGlobalRowOverwrite).length, 4);
  assert.equal(countOverwrites(fixture4, skipGlobalRowOverwrite), 1);

  const overwriteGlobalRowSkip = {
    excluded: new Set(),
    decision: 'overwrite',
    perRow: { 'k-conflict': 'skip' },
  };
  assert.equal(effectiveConflictDecision(fixture4[0], overwriteGlobalRowSkip), 'skip');
  assert.equal(selectWritableRows(fixture4, overwriteGlobalRowSkip).length, 3);
  assert.equal(countOverwrites(fixture4, overwriteGlobalRowSkip), 0);
  assert.deepEqual(buildImportDecisions(fixture4, overwriteGlobalRowSkip), { 'k-conflict': 'skip' });
});

test('取消勾选独立于冲突处置：被排除的冲突行即使设覆盖也不写入', () => {
  const opts = {
    excluded: new Set(['k-conflict']),
    decision: 'overwrite',
    perRow: { 'k-conflict': 'overwrite' },
  };
  assert.equal(selectWritableRows(fixture4, opts).length, 3);
  assert.equal(countOverwrites(fixture4, opts), 0);
  assert.deepEqual(buildImportDecisions(fixture4, opts), { 'k-conflict': 'skip' });
});

test('一致行、问题行不写入；补凭据行计入写入；全冲突且跳过时可写入为 0', () => {
  const mixed = [
    { key: 'a', kind: 'credOnly' },
    { key: 'b', kind: 'identical' },
    { key: 'c', kind: 'invalid' },
    { key: 'd', kind: 'conflict' },
  ];
  assert.deepEqual(
    selectWritableRows(mixed, { decision: 'skip' }).map((r) => r.key),
    ['a'],
  );
  const onlyConflict = [{ key: 'd', kind: 'conflict' }];
  assert.equal(selectWritableRows(onlyConflict, { decision: 'skip' }).length, 0);
  assert.equal(selectWritableRows(onlyConflict, { decision: 'overwrite' }).length, 1);
});
