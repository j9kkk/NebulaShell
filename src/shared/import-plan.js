// 主机导入预览与落盘共享的「写入计划」纯逻辑
//
// 单一口径：预览摘要（「将导入 N 台」）、底栏主按钮（「导入 N 台」/「覆盖 M 台并导入」）、
// 问题区提示、以及最终发给后端的 decisions 映射都从这里算，防止显示数量与实际写入漂移。

/**
 * 冲突行的生效处置：单行覆盖优先于全局策略，非冲突行返回空串。
 * @param {{ key: string, kind: string }} row
 * @param {{ decision?: string, perRow?: Record<string, string> }} [opts]
 */
export function effectiveConflictDecision(row, { decision = 'skip', perRow = {} } = {}) {
  if (!row) return '';
  if (perRow && perRow[row.key]) return perRow[row.key];
  return row.kind === 'conflict' ? decision : '';
}

/**
 * 会真正写盘的行：未取消勾选、非「一致」、非问题行，且冲突行的生效处置为「覆盖」。
 * 冲突行默认/设为「跳过」时不计入（但复选框语义 isExcluded 保持独立）。
 * @param {Array<{ key: string, kind: string }>} rows
 * @param {{ excluded?: Set<string>, decision?: string, perRow?: Record<string, string> }} [opts]
 */
export function selectWritableRows(rows, { excluded = new Set(), decision = 'skip', perRow = {} } = {}) {
  return (rows || []).filter((r) => {
    if (!r) return false;
    if (excluded?.has?.(r.key)) return false;
    if (r.kind === 'identical' || r.kind === 'invalid') return false;
    if (r.kind === 'conflict' && effectiveConflictDecision(r, { decision, perRow }) !== 'overwrite') {
      return false;
    }
    return true;
  });
}

/**
 * 本次会被覆盖写入的冲突主机数（与 selectWritableRows 口径一致）。
 */
export function countOverwrites(rows, opts = {}) {
  return selectWritableRows(rows, opts).filter((r) => r.kind === 'conflict').length;
}

/**
 * 生成传给后端 hosts:importApply 的逐行 decisions 映射。
 */
export function buildImportDecisions(rows, { excluded = new Set(), decision = 'skip', perRow = {} } = {}) {
  const decisions = {};
  for (const row of rows || []) {
    if (!row || row.kind === 'invalid') continue;
    if (excluded?.has?.(row.key)) {
      decisions[row.key] = 'skip';
    } else if (row.kind === 'conflict') {
      decisions[row.key] = effectiveConflictDecision(row, { decision, perRow }) === 'overwrite' ? 'overwrite' : 'skip';
    }
  }
  return decisions;
}
