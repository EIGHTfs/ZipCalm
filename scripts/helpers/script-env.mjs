/*
 * 验收脚本共用的「运行环境基础件」
 *
 * 为什么集中到一处：下面几样在多个脚本里各写一份 ——
 *   ① `PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')`
 *   ② `execFileAsync = promisify(execFile)`
 *   ③ `existsSync(path) ? … : …` 这类"探一下在不在"的写法
 * 各写一份的后果是"改一处忘一处"：某个脚本按自己的 cwd 解析项目根（在别的目录下跑就找不到配置），
 * 或 execFile 的超时/编码口径不一致。这里以**本文件所在目录**为基准推导，不依赖调用者的 cwd。
 */

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

/** 本文件所在目录：<项目根>/scripts/helpers */
export const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 项目根：helpers → scripts → 项目根 */
export const PROJECT_ROOT = path.resolve(HELPERS_DIR, '..', '..');
/** promisify 后的 execFile（用法与回调版一致，只是返回 Promise） */
export const execFileAsync = promisify(execFile);

/**
 * 路径是否存在（异步）。
 * 为什么不用 fs.existsSync：验收脚本里有大量 `await` 在跑，同步 fs 会在这期间卡住事件循环；
 * 而且 existsSync 只能答"在不在"，后面往往还要再读一次——异步版本让"探+读"能用同一个 await 链。
 */
export async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 文件字节数；文件不存在（或读不到）返回 0。
 * 替代 `existsSync(p) ? (await fsp.stat(p)).size : 0` 这种"先探再 stat"的两步写法：一次 await 搞定，
 * 且拿到的 size 与判定用的是同一个时刻的快照。
 */
export async function fileSizeOrZero(target) {
  try {
    return (await fsp.stat(target)).size;
  } catch {
    return 0;
  }
}

/**
 * 从任务响应里取 taskId（信封结构 `{ ok, data: { task: { id } } }`；取不到返回空串）。
 * 各脚本原先都手写 `res.json && res.json.data && res.json.data.task && res.json.data.task.id`，
 * 收成一处后调用点也从四个 `&&` 变成一次调用（既去重也降圈复杂度）。
 */
export function taskIdOf(response) {
  const task = response && response.json && response.json.data && response.json.data.task;
  return (task && task.id) || '';
}
