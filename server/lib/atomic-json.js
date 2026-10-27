// 原子写 JSON（先写临时文件再 rename）
//
// 为什么必须原子：任务/令牌这类状态文件如果被"原地截断写"中途打断，
// 重启后就是半个 JSON —— 直接导致服务起不来。先写 <file>.tmp 再 rename 可保证
// 读到的永远是「旧完整版」或「新完整版」，不存在中间态（docs/12 lib/atomic-json.js）。
//
// 为什么还要重试：CIFS/SMB 的 rename 语义与 POSIX 不同 ——
//   · 目标文件正被别的进程读打开时，rename 会返回 EACCES（瞬时冲突，读完就释放）
//   · rename 过程中存在极短窗口目标不可见，此时读会拿到 ENOENT
// 实测（150 次原子写 + 持续并发读，storage 在 CIFS 上）：写失败 28%、读失败 58%；
// 同样的代码在本地盘上写失败 0%、读失败 2.4%。这两个错误都是**瞬时**的，
// 几十毫秒后即消失，所以有界重试就能覆盖，不需要改动调用方。
//
// 重试不会掩盖真问题：
//   · 真失败（磁盘满 / 权限真的不对 / 目录不存在）会连续重试全败，最终仍抛错
//   · 内容损坏（JSON 解析失败）不重试 —— 那和文件可见性无关，重试也没用

import fs from 'node:fs/promises';
import path from 'node:path';

/** 瞬时错误码：网络盘上由并发读写引起的可见性/共享冲突，重试可恢复 */
const TRANSIENT_CODES = new Set(['EACCES', 'ENOENT', 'EBUSY', 'EPERM']);

const WRITE_RETRIES = 3;
const WRITE_RETRY_DELAY_MS = 50;
const READ_RETRIES = 2;
const READ_RETRY_DELAY_MS = 50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 原子写入 JSON 文件。
 *
 * 瞬时冲突（网络盘的 rename 可见性窗口）会自动重试；真正失败（磁盘满、权限、
 * 目录不存在）重试耗尽后照常抛出，调用方的错误处理逻辑不受影响。
 *
 * @param {string} filePath 目标文件（父目录不存在会自动创建）
 * @param {unknown} data 可被 JSON.stringify 的数据
 */
export async function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const text = `${JSON.stringify(data, null, 2)}\n`;

  let lastError = null;
  for (let attempt = 0; attempt <= WRITE_RETRIES; attempt += 1) {
    try {
      await fs.writeFile(tmpPath, text, 'utf8');
      await fs.rename(tmpPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      // 非瞬时错误（如 ENOSPC）立刻放弃，不做无意义重试
      if (!TRANSIENT_CODES.has(error && error.code)) break;
      if (attempt < WRITE_RETRIES) {
        // 先清掉可能残留的 .tmp，再等一下重试：.tmp 残留会让下次写覆盖同一临时文件，
        // 而并发写的场景下留着它反而可能加剧冲突。
        await fs.rm(tmpPath, { force: true }).catch(() => {});
        await sleep(WRITE_RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  // 重试耗尽仍失败：清理临时文件（避免 .tmp 残留被「无残留」类断言误判成产品泄漏），
  // 目标文件（旧完整版）保持不动，然后把错误抛给调用方。
  await fs.rm(tmpPath, { force: true }).catch(() => {});
  throw lastError;
}

/**
 * 读取 JSON；文件不存在或内容损坏时返回 fallback（不抛错，避免"一个坏文件拖垮启动"）。
 *
 * ENOENT 会短暂重试：网络盘的 rename 有可见性窗口，读到「文件暂时不存在」不代表真丢了。
 * 重试仍读不到才按 not-found 返回 fallback；JSON 解析失败不重试（内容问题重试无意义）。
 *
 * @param {string} filePath
 * @param {unknown} fallback
 * @returns {Promise<{data: unknown, ok: boolean, reason?: string}>}
 */
export async function readJson(filePath, fallback = null) {
  let lastReason = null;
  for (let attempt = 0; attempt <= READ_RETRIES; attempt += 1) {
    try {
      const text = await fs.readFile(filePath, 'utf8');
      return { data: JSON.parse(text), ok: true };
    } catch (error) {
      const code = error && error.code;
      if (code === 'ENOENT') {
        lastReason = 'not-found';
        if (attempt < READ_RETRIES) {
          await sleep(READ_RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        break;
      }
      // 读到了但解析失败（内容损坏）、或权限类错误：重试无意义，直接返回原因
      lastReason = `unreadable:${code}`;
      break;
    }
  }
  return { data: fallback, ok: false, reason: lastReason };
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
