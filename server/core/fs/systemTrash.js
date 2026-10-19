// 群晖系统回收站（Synology `#recycle`）调用封装
//
// 为什么需要它：项目自己的 `storage/trash` 只对"本应用内删除"可恢复，用户在 DSM 的
// File Station 里看不到、也清不掉；而 NAS 用户的心智是"去 File Station 回收站找回来"。
// 群晖自带的 `/usr/syno/bin/synorecycle` 正是这个用途 —— 它不是 `rm -rf`，走的是群晖删除流程：
//
//   synorecycle --unlink share=<共享名> rpath=<共享内相对路径>   # 文件 → #recycle
//   synorecycle --rmdir  share=<共享名> rpath=<共享内相对路径>   # 目录 → #recycle
//
// 两个实测事实（决定了本模块的边界）：
// 1. `#recycle` 的权限**可能可读也可能不可读**（取决于部署方是否放开）：
//    - 可读 → 删后校验可以更强：确认目标真的出现在 `#recycle/<rpath>`；
//    - 不可读 → 退回只看"原位置是否消失"（不能因为读不到回收站就判失败）；
// 2. synorecycle 失败时什么都不会发生 → 调用方必须能回退到项目 trash，
//    所以本模块**只报告失败、绝不自己兜底删除**（函数内没有任何 rm/unlink 作为"补救"）。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 群晖回收站工具（固定路径；不可用就回退项目 trash） */
const SYNORECYCLE_BIN = '/usr/syno/bin/synorecycle';

/** 卷路径：/volume<数字>/<共享名><剩余>；两位数卷号（/volume10）也要支持 */
const VOLUME_SHARE_PATTERN = /^\/volume\d+\/([^/]+)(\/.*)?$/;

/** 以这些字符开头的第一段是系统目录，不是共享文件夹（@appdata / @eaDir / #recycle …） */
const SYSTEM_SHARE_PREFIX = /^[@#]/;

/** 命令超时：删单个文件/目录不该超过它，超时按失败处理（否则任务会一直挂着） */
const COMMAND_TIMEOUT_MS = 30000;

/**
 * 探测群晖回收站是否可用。
 * @returns {{available: boolean, binary: string|null}}
 */
export function detect() {
  try {
    fs.accessSync(SYNORECYCLE_BIN, fs.constants.X_OK);
    return { available: true, binary: SYNORECYCLE_BIN };
  } catch {
    return { available: false, binary: null };
  }
}

/**
 * 绝对路径 → 群晖回收站参数（共享名 + 共享内相对路径）。
 *
 * 规则：`/volume<数字>/<第一段>/<其余>`。
 * 返回 null 的情况（调用方据此回退，不尝试执行）：
 * - 不在 /volumeN 下（如项目自己的 storage/、/mnt/xxx）
 * - 第一段以 @ / # 开头（@appdata / @eaDir / #recycle 不是共享）
 * - 只有卷根（/volume1）或只有共享根（/volume1/VirtualDSM）—— 删"共享本身"不是这个功能的场景
 *
 * @param {string} absPath
 * @returns {{share: string, rpath: string} | null}
 */
export function toSharePath(absPath) {
  if (typeof absPath !== 'string' || absPath.length === 0) return null;
  // 统一成 POSIX 分隔符再解析（本项目内部路径本来就是 POSIX，这里只是防御）
  const normalized = path.posix.normalize(absPath.replace(/\\/g, '/'));
  const matched = normalized.match(VOLUME_SHARE_PATTERN);
  if (!matched) return null;

  const share = matched[1];
  const rest = matched[2] || '';
  if (!share || SYSTEM_SHARE_PREFIX.test(share)) return null;
  // 共享根 / 卷根不删（rpath 为空说明只到共享这一层）
  if (rest.length === 0) return null;

  return { share, rpath: rest };
}

/**
 * 回收站里"这份文件应该在哪"：`/volumeN/<共享>/#recycle/<rpath>`。
 * 实测映射：删 /volume1/VirtualDSM/a/b.txt → /volume1/VirtualDSM/#recycle/a/b.txt
 */
function recyclePathOf(absPath) {
  const normalized = path.posix.normalize(String(absPath).replace(/\\/g, '/'));
  const matched = normalized.match(VOLUME_SHARE_PATTERN);
  if (!matched) return null;
  const shareName = matched[1];
  const shareRoot = normalized.slice(0, normalized.indexOf(shareName) + shareName.length);
  const rpath = matched[2] || '';
  if (rpath.length === 0) return null;
  return path.posix.join(shareRoot, '#recycle', rpath);
}

/** 回收站可读才做加强校验（不可读时返回 null，表示"无法判断"，不当作失败） */
async function recycleDirReadable(absPath) {
  const normalized = path.posix.normalize(String(absPath).replace(/\\/g, '/'));
  const matched = normalized.match(VOLUME_SHARE_PATTERN);
  if (!matched) return null;
  const shareName = matched[1];
  const shareRoot = normalized.slice(0, normalized.indexOf(shareName) + shareName.length);
  const recycleRoot = path.posix.join(shareRoot, '#recycle');
  try {
    await fsp.readdir(recycleRoot);
    return recycleRoot;
  } catch {
    return null;
  }
}

/**
 * 删后加强校验：目标是否真的出现在回收站里。
 * synorecycle 返回后落点可能有毫秒级延迟，所以**轮询**而不是只看一次。
 * @returns {Promise<{verifiable: boolean, found: boolean}>}
 */
async function verifyInRecycle(absPath) {
  const candidate = recyclePathOf(absPath);
  if (!candidate) return { verifiable: false, found: false };
  const recycleRoot = await recycleDirReadable(absPath);
  if (!recycleRoot) return { verifiable: false, found: false };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await exists(candidate)) return { verifiable: true, found: true };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { verifiable: true, found: false };
}

/** 原位置是否还在（stat 成功即存在；权限错误按"存在"处理，宁可判失败也不误报成功） */
async function exists(absPath) {
  try {
    await fsp.lstat(absPath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    return true;
  }
}

/**
 * 执行一次 synorecycle。
 * @param {string} flag `--unlink` | `--rmdir`
 * @param {{share: string, rpath: string}} target
 * @param {string} [binary] 可注入（测试里用假二进制验证失败回退路径）
 * @returns {Promise<{ok: boolean, reason?: string, detail?: string}>}
 */
async function runSynorecycle(flag, target, binary) {
  const bin = binary || SYNORECYCLE_BIN;
  try {
    await execFileAsync(bin, [flag, `share=${target.share}`, `rpath=${target.rpath}`], {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true };
  } catch (error) {
    // 捕获退出码与 stderr：出问题时日志里要能看出是"没有权限"还是"共享名不对"
    const detail = [error && error.code, error && error.stderr, error && error.message]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 500);
    return { ok: false, reason: 'command_failed', detail };
  }
}

/**
 * 通用流程：解析 → 存在性/类型检查 → 执行 → **删后校验原位置已消失**。
 * @param {'--unlink'|'--rmdir'} flag
 * @param {string} absPath
 * @param {'file'|'dir'} expectType
 * @param {{binary?: string}} [options]
 */
async function recycle(flag, absPath, expectType, options = {}) {
  const target = toSharePath(absPath);
  if (!target) return { ok: false, reason: 'not_in_share' };

  const detected = detect();
  const binary = options.binary || detected.binary;
  if (!binary) return { ok: false, reason: 'unavailable' };

  let stat = null;
  try {
    stat = await fsp.lstat(absPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: false, reason: 'not_found' };
    return { ok: false, reason: 'stat_failed', detail: String(error && error.message).slice(0, 200) };
  }
  if (expectType === 'file' && stat.isDirectory()) return { ok: false, reason: 'is_directory' };
  if (expectType === 'dir' && !stat.isDirectory()) return { ok: false, reason: 'not_a_directory' };

  const run = await runSynorecycle(flag, target, binary);
  if (!run.ok) return run;

  // 删后校验第一层：原位置必须消失（返回成功却还在 = 假成功，必须按失败上报）
  if (await exists(absPath)) return { ok: false, reason: 'still_exists', detail: 'synorecycle 返回成功但原位置仍在' };

  // 删后校验第二层（能读回收站时）：确认它真的躺在 #recycle 里；读不到就退回只看原位消失
  const recycled = await verifyInRecycle(absPath);
  if (recycled.verifiable && !recycled.found) {
    return { ok: false, reason: 'not_in_recycle', detail: '原位已消失，但回收站里找不到目标（可能被其他策略清理）' };
  }
  return { ok: true, verifiedInRecycle: recycled.verifiable ? recycled.found : null };
}

/**
 * 把文件移入群晖系统回收站。
 * 失败只返回原因，**不做任何兜底删除**（回退由调用方决定）。
 */
export async function unlinkFile(absPath, options = {}) {
  return recycle('--unlink', absPath, 'file', options);
}

/** 把目录移入群晖系统回收站（同样只报告，不兜底）。 */
export async function rmdirDir(absPath, options = {}) {
  return recycle('--rmdir', absPath, 'dir', options);
}
