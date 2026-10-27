// RAR 格式包（**只读：仅解压，不支持压缩**）
//
// 法律边界（docs/18 §附三）：RAR 的压缩算法是闭源商业算法，未经授权不能生成 RAR 文件；
// 因此 `create()` / `estimate()` 一律拒绝，并在 `unavailableReason()` 里写明原因。
// 解压走**用户已安装**的 unrar（优先）或 7z —— 调用外部程序合法，且**绝不把二进制打进仓库**。
//
// 复用的既有设施（不造第二套）：
// - 条目安全：`_shared/entrySafety.js` 的 planTargets / writePlan（与 zip、tar 同一套 zip-slip 防护
//   与「不覆盖同名」检查），外部程序先解到中转目录，再由这套代码做白名单判定后搬进目标目录
// - 错误三态（P4）：MISSING_PASSWORD / BAD_PASSWORD / ARCHIVE_CORRUPTED，判定见 unrar.js 的 mapToolFailure
//
// 为什么先解到中转目录再搬：unrar 会按归档内的路径直接写盘，若归档里有 `../` 或绝对路径条目，
// 外部程序可能写到目标目录之外。中转 + planTargets 才能保证"写之前先判定"。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { ERROR_CODES, apiError } from '../../../lib/errors.js';
import { planTargets, writePlan } from '../_shared/entrySafety.js';
import {
  EXTRACT_TIMEOUT_MS,
  LIST_TIMEOUT_MS,
  hasEncryptionFlag,
  mapToolFailure,
  parseBareList,
  parseTechnicalList,
  pickBinaries,
  probeUnrarVersion,
  runCommand,
} from './unrar.js';

const FORMAT_ID = 'rar';

/** 压缩侧的统一拒绝文案（法律边界，措辞不要弱化） */
const CREATE_REFUSED = 'RAR 压缩算法为闭源商业算法，未授权不能生成 RAR 文件；本插件仅支持解压';

/** 进度上报的最小间隔（解析外部程序输出时自己节流，避免每行都推一次） */
const PROGRESS_INTERVAL_MS = 120;

/** 当前可用后端：unrar 优先（7z 16.02 对 rar5 会 exit 2，只能算兜底） */
function currentBinary() {
  const tools = pickBinaries();
  if (tools.unrar) return { bin: tools.unrar, kind: 'unrar' };
  if (tools.sevenZip) return { bin: tools.sevenZip, kind: '7z' };
  return null;
}

async function available() {
  return currentBinary() !== null;
}

async function unavailableReason() {
  return '未找到 unrar/7z，无法解压 RAR（请安装 unrar，或用 ZC_UNRAR_BIN / ZC_7Z_BIN 指定路径）';
}

async function estimate() {
  // 压缩侧不支持：抛错而不是返回 0，避免"预检通过然后建任务失败"
  throw apiError(ERROR_CODES.UNSUPPORTED_FORMAT, CREATE_REFUSED);
}

async function create() {
  throw apiError(ERROR_CODES.UNSUPPORTED_FORMAT, CREATE_REFUSED);
}

/** 7z 的技术列表（`-slt` 的 `Key = Value` 形式）——只在没有 unrar 时用到 */
function parseSevenZipList(output) {
  const entries = [];
  let current = null;
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('Path = ')) {
      if (current && current.name) entries.push(current);
      current = { name: line.slice(7), type: 'file', size: 0, compressedSize: 0 };
      continue;
    }
    if (!current) continue;
    if (line === 'Folder = +') current.type = 'dir';
    const sizeMatch = line.match(/^Size = (\d+)/);
    if (sizeMatch) current.size = Number(sizeMatch[1]);
    const packedMatch = line.match(/^Packed Size = (\d+)/);
    if (packedMatch) current.compressedSize = Number(packedMatch[1]);
  }
  if (current && current.name) entries.push(current);
  // 7z 会把归档自身作为第一条列出来，去掉它
  return entries.slice(1).map((entry) => ({
    name: String(entry.name).replace(/\\/g, '/'),
    type: entry.type,
    size: entry.type === 'dir' ? 0 : entry.size,
    compressedSize: entry.compressedSize,
  }));
}

/**
 * 读条目清单；同时判定是否加密。
 * 解析失败（输出格式随版本变）→ 降级成 `lb` 裸名列表，**不报错**。
 * @returns {Promise<{entries: Array, encrypted: boolean, degraded: boolean}>}
 */
async function inspectEntries(archivePath, binary) {
  if (binary.kind === '7z') {
    const outcome = await runCommand(binary.bin, ['l', '-slt', '-p-', archivePath], { timeoutMs: LIST_TIMEOUT_MS });
    if (outcome.code !== 0) mapToolFailure(outcome, { hasPassword: false });
    const entries = parseSevenZipList(outcome.stdout);
    const encrypted = /Encrypted = \+/i.test(outcome.stdout);
    return { entries, encrypted, degraded: false };
  }

  const technical = await runCommand(binary.bin, ['lt', '-p-', archivePath], { timeoutMs: LIST_TIMEOUT_MS });
  if (technical.code !== 0) mapToolFailure(technical, { hasPassword: false });
  const entries = parseTechnicalList(technical.stdout);
  const encrypted = hasEncryptionFlag(technical.stdout);
  if (entries.length > 0) return { entries, encrypted, degraded: false };

  // 降级：只拿名字（大小未知 → 0）。宁可"信息少一点"，也不要因为解析不了就报错。
  const bare = await runCommand(binary.bin, ['lb', '-p-', archivePath], { timeoutMs: LIST_TIMEOUT_MS });
  if (bare.code !== 0) mapToolFailure(bare, { hasPassword: false });
  return { entries: parseBareList(bare.stdout), encrypted, degraded: true };
}

async function list(archivePath) {
  const binary = currentBinary();
  if (!binary) throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, await unavailableReason());
  const info = await inspectEntries(archivePath, binary);
  const items = info.entries.map((entry) => ({
    name: entry.name,
    type: entry.type,
    size: entry.size,
    compressedSize: entry.compressedSize,
  }));
  // encrypted 必须透出：解压预检据此让前端弹密码框（P4 三态的第一道）
  return { entries: items, count: items.length, truncated: false, encrypted: info.encrypted };
}

async function test(archivePath, options = {}) {
  const binary = currentBinary();
  if (!binary) throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, await unavailableReason());
  const password = options && typeof options.password === 'string' ? options.password : '';
  const { entries } = await inspectEntries(archivePath, binary);
  const args = ['t', password ? `-p${password}` : '-p-', archivePath];
  const outcome = await runCommand(binary.bin, args, { timeoutMs: LIST_TIMEOUT_MS });
  if (outcome.code !== 0) mapToolFailure(outcome, { hasPassword: Boolean(password) });
  return {
    ok: true,
    checked: entries.filter((entry) => entry.type !== 'dir').length,
    failures: [],
    strategy: `${binary.kind}-test`,
  };
}

/** 递归收集中转目录里的条目（符号链接一律不收：解压产物里不该有链接） */
async function collectStaged(stagingDir) {
  const collected = [];
  const walk = async (dirAbs, relativePrefix) => {
    const dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
    for (const dirent of dirents) {
      const abs = path.join(dirAbs, dirent.name);
      const relative = relativePrefix ? `${relativePrefix}/${dirent.name}` : dirent.name;
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        collected.push({ name: `${relative}/`, isDir: true, size: 0, link: false, open: null });
        await walk(abs, relative);
        continue;
      }
      if (!dirent.isFile()) continue;
      const stat = await fsp.lstat(abs).catch(() => null);
      collected.push({
        name: relative,
        isDir: false,
        size: stat ? stat.size : 0,
        link: false,
        open: () => fs.createReadStream(abs),
      });
    }
  };
  await walk(stagingDir, '');
  return collected;
}

/**
 * 阶段一（外部程序解到中转目录）的进度：解析 `Extracting  <name>  OK` 行 → **文件级**。
 *
 * 为什么 processedBytes 固定为 0：unrar 不报字节数（只给文件名与百分比），若这里按文件数
 * 比例估算字节，阶段二搬移时 writePlan 会从 0 重新计数 → 进度会**倒退**。宁可这一阶段只给
 * 文件名（"正在解第 N 个"），阶段二再给精确字节，保证整条进度流单调不减。
 */
function makeExtractReporter(onProgress, totalFiles) {
  let processedFiles = 0;
  let lastAt = 0;
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  return (line) => {
    // 真实输出形如 `Extracting  s2/a.txt      OK`；头部还有一行 `Extracting from <archive>` 要排除
    if (/^Extracting\s+from\s+/i.test(line)) return;
    const matched = line.match(/^Extracting\s+(.+)$/i);
    if (!matched) return;
    const name = matched[1].replace(/\s+\d+%\s*$/, '').replace(/\s+OK\s*$/i, '').trim();
    if (!name) return;
    processedFiles += 1;
    const now = Date.now();
    if (now - lastAt < PROGRESS_INTERVAL_MS) return;
    lastAt = now;
    report({ processedFiles, totalFiles, processedBytes: 0, currentFile: name });
  };
}

async function extract(ctx) {
  const binary = currentBinary();
  if (!binary) throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, await unavailableReason());

  const startedAt = Date.now();
  const targetDir = path.resolve(ctx.targetDir);
  const overwrite = Boolean(ctx.options && ctx.options.overwrite);
  const password = ctx.options && typeof ctx.options.password === 'string' ? ctx.options.password : '';
  const signal = ctx.options && ctx.options.signal;

  // ⓪ 先读清单：既拿到文件数（进度分母/校验），也判定是否加密
  const info = await inspectEntries(ctx.archivePath, binary);
  if (info.encrypted && !password) {
    throw apiError(ERROR_CODES.MISSING_PASSWORD, '该压缩包已加密，请输入密码');
  }

  // ① 解到目标目录**旁边**的中转目录（外部程序不直接写用户目录）
  const stagingDir = path.join(path.dirname(targetDir), `.${path.basename(targetDir)}.hl-rar-${Date.now()}`);
  await fsp.mkdir(stagingDir, { recursive: true });
  try {
    const fileCount = info.entries.filter((entry) => entry.type !== 'dir').length;
    const args = ['x', '-o-', '-y', password ? `-p${password}` : '-p-', ctx.archivePath, `${stagingDir}/`];
    const outcome = await runCommand(binary.bin, args, {
      timeoutMs: EXTRACT_TIMEOUT_MS,
      signal,
      onLine: makeExtractReporter(ctx.onProgress, fileCount),
    });
    if (outcome.code !== 0) mapToolFailure(outcome, { hasPassword: Boolean(password) });

    // ② 安全判定 + 搬进目标目录（zip-slip / 不覆盖同名 / 进度 / 半成品清理 都由这套共享代码负责）
    const staged = await collectStaged(stagingDir);
    const planned = await planTargets(staged, targetDir, overwrite);
    const written = await writePlan(planned, targetDir, { signal, onProgress: ctx.onProgress });
    return {
      targetDir,
      entries: written.entries,
      bytesOut: written.bytesOut,
      durationMs: Date.now() - startedAt,
      encrypted: info.encrypted,
    };
  } finally {
    // 中转目录无论成败都清掉（加密包的明文副本不留盘）
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

export default {
  id: FORMAT_ID,
  name: 'RAR（仅解压）',
  ext: '.rar',
  // RAR5 也走同一扩展名，没有别的别名
  extAliases: [],
  mime: 'application/vnd.rar',
  // 压缩侧不可用：levelRange/defaultLevel 置空，前端压缩设置不该出现它
  levelRange: null,
  defaultLevel: null,
  capabilities: [],
  /** 只解压标记：压缩列表据此排除本格式（消费方见 README 的格式说明） */
  extractOnly: true,
  available,
  unavailableReason,
  estimate,
  create,
  extract,
  list,
  test,
  /**
   * 探测归档是否加密（供解压预检决定是否弹密码输入框）。
   *
   * 实现方式是复用列表阶段已经拿到的信息：`unrar lt` 的输出里每一条都带
   * `* Encrypted = +` 标志，`7z -slt` 同理，所以不需要额外开一次进程去猜测。
   * RAR 没有 ZIP 那种 AES/ZipCrypto 之分，`isAes` 恒为 false（保持与 ZIP 同构的返回形状）。
   *
   * @param {string} archivePath
   * @returns {Promise<{encrypted: boolean, isAes: boolean}>}
   */
  async probeEncryption(archivePath) {
    const binary = currentBinary();
    if (!binary) throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, await unavailableReason());
    const info = await inspectEntries(archivePath, binary);
    return { encrypted: info.encrypted === true, isAes: false };
  },
  /**
   * 用给定密码完整试解一次（供解压侧「先校验」阶段调用）。
   *
   * 为什么必须由本插件提供、而不是让编排层统一用 7z：
   * p7zip 16.02 读不了加密 RAR5（实测报 `Can not open the file as archive`），
   * 而本机 `unrar 5.70` 可以。工具能力按格式不同，这个知识属于插件自己。
   *
   * @param {string} archivePath
   * @param {string} password
   * @returns {Promise<{ok: boolean, checked?: number, strategy?: string, error?: string}>}
   */
  async verifyWithPassword(archivePath, password) {
    try {
      const result = await test(archivePath, { password });
      return { ok: true, checked: result.checked, strategy: result.strategy };
    } catch (error) {
      // 保留原始错误码（BAD_PASSWORD / ARCHIVE_CORRUPTED / ABORTED），交给上层原样抛给用户。
      // 如果在这里一律收敛成 VERIFY_FAILED，用户看到的就只是"校验未通过"，
      // 分不清到底是密码打错了还是包坏了 —— 三态区分就白做了。
      return {
        ok: false,
        code: (error && error.code) || null,
        error: (error && error.message) || '加密包校验失败',
      };
    }
  },
  /** 便于测试与诊断：探测到的 unrar 版本（拿不到为 null） */
  probe: () => {
    const tools = pickBinaries();
    return { ...tools, unrarVersion: tools.unrar ? probeUnrarVersion(tools.unrar) : null };
  },
};
