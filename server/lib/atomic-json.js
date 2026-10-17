// 原子写 JSON（先写临时文件再 rename）
//
// 为什么必须原子：任务/令牌这类状态文件如果被"原地截断写"中途打断，
// 重启后就是半个 JSON —— 直接导致服务起不来。先写 <file>.tmp 再 rename 可保证
// 读到的永远是「旧完整版」或「新完整版」，不存在中间态（docs/12 lib/atomic-json.js）。

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 原子写入 JSON 文件。
 * @param {string} filePath 目标文件（父目录不存在会自动创建）
 * @param {unknown} data 可被 JSON.stringify 的数据
 */
export async function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const text = `${JSON.stringify(data, null, 2)}\n`;
  try {
    await fs.writeFile(tmpPath, text, 'utf8');
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    // 写失败路径清理：.tmp 残留会一直存在到下次成功写，且会让「无 .tmp 残留」类
    // 断言/体检误报产品泄漏。只清本次创建的临时文件，目标文件（旧完整版）不动。
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * 读取 JSON；文件不存在或内容损坏时返回 fallback（不抛错，避免"一个坏文件拖垮启动"）。
 * @param {string} filePath
 * @param {unknown} fallback
 * @returns {Promise<{data: unknown, ok: boolean, reason?: string}>}
 */
export async function readJson(filePath, fallback = null) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return { data: JSON.parse(text), ok: true };
  } catch (error) {
    return {
      data: fallback,
      ok: false,
      reason: error && error.code === 'ENOENT' ? 'not-found' : `unreadable:${error && error.code}`,
    };
  }
}

/** 确保目录存在（幂等） */
export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/** 检查路径是否可读写（用于配置校验时给出明确原因） */
export async function checkAccess(targetPath, mode) {
  try {
    await fs.access(targetPath, mode);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error && error.code ? error.code : 'EUNKNOWN' };
  }
}
