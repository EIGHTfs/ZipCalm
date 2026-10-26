// 加密密码能力插件（docs/19 §4.2 能力契约）
//
// 职责边界（docs/19 关键约束）：**不碰文件系统、不碰 archiver**——
// 只做「参数校验 + 参数翻译（prepareCreate）+ 压后自测编排（verify）+ 候选密码序列 + 脱敏」。
// 真正写盘由 zip 格式插件完成；删除护栏由 orchestrator/deleter 按 verify 结果执行。
//
// 算法可追加：methods/ 下加一个模块文件即可，本文件零改动（docs/19 §4.3）。
//
// 解压侧能力边界（P4 实测结论）：
// - unzipper 内置 Decrypt.js 只实现 **ZipCrypto**（纯 CRC 表流式解密，无 AES）；
// - AES-256（WinZip AES，compressionMethod=99）unzipper 会按 inflate 误解 → 表现为
//   「inflate 失败/坏数据」，**不是密码错误**。所以解压侧必须先判加密方法：
//   aes256 → 明确提示「当前不支持 AES-256 解压，请用 7-Zip」；zip20 → 带密码解，
//   错密码提示「密码错误」。

import { ERROR_CODES, apiError } from '../../../lib/errors.js';

import aes256 from './methods/aes256.js';
import zip20 from './methods/zip20.js';

/** 算法表（key = method id）。追加算法 = 加一个 methods/*.js + 这里一行注册 */
const METHODS = new Map([
  [aes256.id, aes256],
  [zip20.id, zip20],
]);

/** zip 加密条目标志位（general purpose bit 0） */
const FLAG_ENCRYPTED = 0x1;
/** WinZip AES 的伪压缩方法号（central directory compressionMethod=99） */
const COMPRESSION_METHOD_AES = 99;

function methodById(id) {
  return METHODS.get(id) || null;
}

export default {
  id: 'password',
  name: '加密密码',

  // 双向声明（docs/19 §4.2）：与格式插件的 capabilities 取交集才生效
  appliesTo: ['zip'],

  // 参数字段（算法枚举不在这里——由 methods/ 动态提供）
  params: {
    password: { type: 'string', required: true, secret: true, minLength: 1, maxLength: 1024 },
    method: { type: 'methodRef', required: false, default: 'aes256' },
  },

  /**
   * 参数校验与规范化（PW-4：后端独立校验，不信任前端）。
   * @param {{password?: string, method?: string}} raw
   * @param {{formatId: string}} context
   * @returns {{ok: true, value: {password: string, method: string}} | {ok: false, error: {code, message, details}}}
   */
  validateParams(raw, { formatId } = {}) {
    if (!raw || typeof raw.password !== 'string' || raw.password.length === 0) {
      return { ok: false, error: { code: ERROR_CODES.VALIDATION_FAILED, message: '密码不能为空' } };
    }
    if (raw.password.length > this.params.password.maxLength) {
      return { ok: false, error: { code: ERROR_CODES.VALIDATION_FAILED, message: `密码过长（上限 ${this.params.password.maxLength} 字符）` } };
    }
    const methodId = raw.method || this.params.method.default;
    const method = methodById(methodId);
    if (!method) {
      return { ok: false, error: { code: ERROR_CODES.VALIDATION_FAILED, message: `未知加密算法：${String(methodId)}` } };
    }
    if (!method.available()) {
      return { ok: false, error: { code: ERROR_CODES.VALIDATION_FAILED, message: `算法 ${method.name} 当前不可用` } };
    }
    if (formatId && !this.appliesTo.includes(formatId)) {
      // PW-4 双保险：格式没声明能力 → 400（前端置灰只是体验）
      return { ok: false, error: { code: ERROR_CODES.VALIDATION_FAILED, message: `格式 ${formatId} 不支持加密能力` } };
    }
    return { ok: true, value: { password: raw.password, method: methodId } };
  },

  /**
   * 压缩前：把能力参数翻译成格式插件认识的东西（不做 IO）。
   * @returns {{archiverFormat: string, extra: {encryptionMethod: string, password: string}}}
   */
  prepareCreate({ params }) {
    const method = methodById(params.method) || methodById(this.params.method.default);
    return {
      archiverFormat: method.engine.archiverFormat,
      extra: {
        encryptionMethod: method.engine.encryptionMethod,
        password: params.password,
      },
    };
  },

  /**
   * 压缩后自测（PW-2：删除原文件的前置条件）——用同一密码试解一次。
   *
   * 实现走 unzipper.Open.file（与格式插件 test() 同一读取面）：
   * - 全部条目带密码完整读通 + CRC 一致 → ok；
   * - 任何条目读失败 → !ok（编排层把任务置 failed(VERIFY_FAILED)，INV-01 拦住删除）。
   *
   * @param {{archivePath: string, params: {password: string, method: string}, formatApi: object}} args
   */
  async verify({ archivePath, params }) {
    const method = methodById(params.method);
    if (!method) return { ok: false, error: `未知算法 ${params.method}` };
    // 统一走 7z 试解：
    // unzipper 只有 ZipCrypto 的解密实现，AES-256 包（compressionMethod=99）会被它
    // 当成普通 inflate 解读 → 报「inflate 失败/坏数据」或 BAD_PASSWORD，属**假阴性**。
    // 7-Zip 两种加密都能读，且本机与 NAS 上通常都有；探测不到时明确报错，不静默放行。
    return verifyWith7z(archivePath, params.password);
  },

  /**
   * 解压时：给出候选密码序列（用户输入优先，其次常用密码本按 lastUsedAt 倒序）。
   * P3 的密码本由调用方注入 candidates；本能力只定义顺序语义。
   */
  prepareExtract({ userPassword, archiveCandidates = [] }) {
    const candidates = [];
    if (userPassword) candidates.push(userPassword);
    for (const item of archiveCandidates) {
      const value = typeof item === 'string' ? item : item && item.password;
      if (value && !candidates.includes(value)) candidates.push(value);
    }
    return { candidates };
  },

  /**
   * 脱敏（PW-1）：日志 / API 响应 / 落盘一律过这里——只留布尔与方法名，绝不回明文。
   */
  redact(params) {
    return {
      hasPassword: Boolean(params && params.password),
      method: params && params.method ? params.method : undefined,
    };
  },

  /**
   * 加密元数据（GET /capabilities/password 用）：给前端渲染算法下拉与 caveat。
   * 绝不包含任何密码值。
   */
  describe() {
    return {
      id: this.id,
      name: this.name,
      appliesTo: [...this.appliesTo],
      methods: [...METHODS.values()].map((method) => ({
        id: method.id,
        name: method.name,
        description: method.description,
        compatibility: method.compatibility,
        caveat: method.caveat,
        available: method.available(),
      })),
    };
  },

  /**
   * 解压侧加密判定（P4）：给格式插件 extract 用——判别条目加密方式。
   * @param {{flags?: number, compressionMethod?: number}} entryVars unzipper 条目变量
   * @returns {'none' | 'zip20' | 'aes-unsupported'}
   */
  classifyEntry(entryVars) {
    const flags = Number(entryVars && entryVars.flags) || 0;
    if ((flags & FLAG_ENCRYPTED) === 0) return 'none';
    if (Number(entryVars && entryVars.compressionMethod) === COMPRESSION_METHOD_AES) return 'aes-unsupported';
    return 'zip20';
  },

  /** 算法表暴露（解压侧/路由查询 caveat 用） */
  methods: METHODS,
};

// —— 内部工具（不导出） ——

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

import unzipperPkg from 'unzipper';
const unzipper = unzipperPkg;

const execFileAsync = promisify(execFile);

/**
 * 探测 7z 可执行文件（tool-self-detection：环境变量 → PATH → 常见绝对路径）。
 * 找不到返回 null，由调用方给**明确错误**，绝不静默当作「验证通过」。
 */
let cached7z = null;
let cached7zProbed = false;
function resolve7zBinary() {
  if (cached7zProbed) return cached7z;
  cached7zProbed = true;
  const candidates = [
    process.env.ZC_7Z_BIN,
    '7z',
    '7za',
    '7zz',
    '/bin/7z',
    '/usr/bin/7z',
    '/usr/local/bin/7z',
    '/volume1/@appstore/7-Zip/usr/local/bin/7z',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      // 只做「能否调用」的轻量探测：--help 在 7z 各分支上都可用且不碰归档
      execFileSync(candidate, ['--help'], { stdio: 'ignore', timeout: 5000 });
      cached7z = candidate;
      return cached7z;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

/**
 * 用 7z 试解一次加密包（PW-2 的实现）。
 * 7z t 会校验 CRC 并要求正确密码 —— 等价于「用这个密码完整读一遍」。
 */
export async function verifyWith7z(archivePath, password) {
  const binary = resolve7zBinary();
  if (!binary) {
    return { ok: false, error: '未找到 7z，无法自测加密包（可设置 ZC_7Z_BIN 指定路径）' };
  }
  try {
    await execFileAsync(binary, ['t', `-p${password}`, '-y', archivePath], {
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true };
  } catch (error) {
    const output = `${error && error.stdout ? error.stdout : ''}${error && error.stderr ? error.stderr : ''}`;
    if (/wrong password|password is incorrect|加密|密码/i.test(output)) {
      return { ok: false, error: '密码错误' };
    }
    return { ok: false, error: (error && error.message) || '加密包自测失败' };
  }
}

async function unzipperOpen(archivePath) {
  return unzipper.Open.file(archivePath);
}

function isDirectoryEntry(entry) {
  return /\/$/.test(String(entry.path)) || entry.type === 'Directory';
}

/**
 * 7z 实际解包（P4：AES-256 与 ZipCrypto 的统一解压通道——unzipper 只认 ZipCrypto，
 * AES 走它必假阴性，所以加密包解压统一走 7z，一个实现两种算法）。
 *
 * 解到 **指定输出目录**（调用方传入临时目录），zip-slip 由两层防护：
 * ① 7z 自身的路径规范化（p7zip 对 `../` 条目会拒绝或剥离）；
 * ② 调用方在解包后仍走 planTargets 白名单链把文件**搬**进最终目标（不在解包目录直接交付）。
 *
 * @returns {{ok: true} | {ok: false, code: 'BAD_PASSWORD'|'ARCHIVE_CORRUPTED'|'SEVENZIP_MISSING'|'INTERNAL_ERROR', message: string}}
 */
export async function extractWith7z(archivePath, password, outputDir) {
  const binary = resolve7zBinary();
  if (!binary) {
    return {
      ok: false,
      code: 'SEVENZIP_MISSING',
      message: '当前环境缺少 7z，无法解压加密压缩包，请安装 7-Zip 或设置 ZC_7Z_BIN 环境变量',
    };
  }
  try {
    await execFileAsync(binary, ['x', `-p${password}`, '-y', `-o${outputDir}`, archivePath], {
      timeout: 600000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true };
  } catch (error) {
    const output = `${error && error.stdout ? error.stdout : ''}${error && error.stderr ? error.stderr : ''}`;
    if (/wrong password/i.test(output)) {
      return { ok: false, code: 'BAD_PASSWORD', message: '密码错误' };
    }
    if (/Cannot open|Errors|ERROR/i.test(output) && /corrupt|损坏|unexpected end/i.test(output)) {
      return { ok: false, code: 'ARCHIVE_CORRUPTED', message: '压缩包损坏' };
    }
    return { ok: false, code: 'INTERNAL_ERROR', message: (error && error.message) || '解压失败' };
  }
}

/** 7z 可用性探测（解压路由判「缺 7z」用，不执行解包） */
export function sevenZipAvailable() {
  return resolve7zBinary() !== null;
}

/** 加密条目检测（供 extract 路由/格式包判别）：任一非目录条目加密 → true */
export async function archiveHasEncryption(archivePath) {
  const directory = await unzipperOpen(archivePath);
  for (const entry of directory.files) {
    if (isDirectoryEntry(entry)) continue;
    const flags = Number(entry.flags) || 0;
    if ((flags & FLAG_ENCRYPTED) !== 0) {
      return { encrypted: true, isAes: Number(entry.compressionMethod) === COMPRESSION_METHOD_AES };
    }
  }
  return { encrypted: false, isAes: false };
}
