/*
 * 验收脚本共用的「运行环境基础件」
 *
 * 为什么集中到一处：下面两样在 5 个脚本里各写一份 ——
 *   ① `PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')`
 *   ② `execFileAsync = promisify(execFile)`
 * 各写一份的后果是"改一处忘一处"：某个脚本按自己的 cwd 解析项目根（在别的目录下跑就找不到配置），
 * 或 execFile 的超时/编码口径不一致。这里以**本文件所在目录**为基准推导，不依赖调用者的 cwd。
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

/** 本文件所在目录：<项目根>/scripts/helpers */
export const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 项目根：helpers → scripts → 项目根 */
export const PROJECT_ROOT = path.resolve(HELPERS_DIR, '..', '..');
/** promisify 后的 execFile（用法与回调版一致，只是返回 Promise） */
export const execFileAsync = promisify(execFile);
