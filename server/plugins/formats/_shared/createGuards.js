// 格式包共用的「创建前置守卫」（各格式不许各写一份，避免漂移）
//
// 契约（docs/M0/插件契约.md §3.4 第 7 条）：**绝不覆盖** ——
// `tempPath`（`outputPath + '.part'`）与 `outputPath` 任一已存在就必须直接抛 TARGET_EXISTS，
// 由总入口负责命名唯一化；格式包不许自作主张覆盖或改名。

import fs from 'node:fs';

import { ERROR_CODES, apiError } from '../../../lib/errors.js';
import { safeName } from './entrySafety.js';

/**
 * @param {{tempPath: string, outputPath: string}} ctx 格式包上下文
 * @param {() => Promise<boolean>} isAvailable 该格式的可用性探测
 * @param {string} formatId 用于错误提示的格式 id
 */
export async function assertCreatable(ctx, isAvailable, formatId) {
  if (!(await isAvailable())) {
    throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, `${formatId} 格式当前不可用`);
  }
  if (fs.existsSync(ctx.tempPath)) {
    throw apiError(ERROR_CODES.TARGET_EXISTS, '临时产物已存在', { file: safeName(ctx.tempPath) });
  }
  if (fs.existsSync(ctx.outputPath)) {
    throw apiError(ERROR_CODES.TARGET_EXISTS, '目标压缩包已存在（绝不覆盖）', { file: safeName(ctx.outputPath) });
  }
}
