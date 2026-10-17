// 压缩黑名单（三层：全局默认 / 用户自定义 / 任务级临时）+ 匹配与「命中哪一层」
//
// 契约：
// - docs/04 §三：三层表 + 「命中后跳过但保留在原目录」（绝不能进删除集合）
// - docs/M0/API规范.md §4.5：三端点形状；§4.2 目录列表的 blacklisted/blacklistLayer；
//   §compress/preflight 的 skipped[]{path,pattern,layer}
// - docs/09 §五：黑名单匹配归服务端（不信任前端）
//
// 为什么要单独一个模块：匹配规则会被三处消费 —— 预检（告知"会跳过几个"）、真实打包（真的不压）、
// 目录列表（给每个条目标注）。三处必须用**同一份判定**，否则"预检说跳过 3 个、实际压了 3 个"这种
// 漂移几乎必然会来。所以这里既提供纯函数（compile/resolve/match），也提供用户层的读写。

import fsp from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomic } from '../../lib/atomic-json.js';

/** 层名（对外字段 blacklistLayer 的取值；顺序即优先级：越靠前越具体） */
export const BLACKLIST_LAYERS = Object.freeze({
  TASK: 'task',
  USER: 'user',
  GLOBAL: 'global',
});

/**
 * 全局默认层：已压缩格式 + 系统垃圾（不可删、不可改；可被任务级开关整体关掉）。
 * 依据 docs/04 §四「智能跳过」表：jpg/png/mp4/mp3、zip/7z/rar/gz、docx/xlsx/pptx 再压几乎无收益。
 * 系统垃圾（Thumbs.db/.DS_Store/@eaDir）本来就不该进包。
 */
export const GLOBAL_PATTERNS = Object.freeze([
  '*.jpg',
  '*.jpeg',
  '*.png',
  '*.mp4',
  '*.mp3',
  '*.zip',
  '*.7z',
  '*.rar',
  '*.gz',
  '*.docx',
  '*.xlsx',
  '*.pptx',
  'Thumbs.db',
  '.DS_Store',
  '@eaDir',
]);

/** 契约 §4.5 的校验上限 */
export const MAX_PATTERN_LENGTH = 128;
export const MAX_PATTERNS = 200;

/** 用户层文件名（独立文件：config.json 是启动期只读快照，没有写回通道，不适合放用户可改的设置） */
const USER_FILE = 'blacklist-user.json';

/** 用户层默认值 */
function emptyUserLayer() {
  return { enabled: true, patterns: [], updatedAt: null };
}

/**
 * 校验一串 pattern（PUT /blacklist/user 用）。
 * 契约要求：单条 ≤128 字符、总数 ≤200、拒绝绝对路径与 `/`。
 * 另外这里把"空串/纯空白"也拒掉（否则会变成"什么都不匹配"的死条目，用户看不出为什么没生效）。
 * @returns {{ok: true, patterns: string[]} | {ok: false, message: string}}
 */
/** 单条校验（返回规范化后的字符串，或错误消息） */
function validateOnePattern(raw) {
  if (typeof raw !== 'string') return { ok: false, message: 'patterns 里每一项都必须是字符串' };
  const pattern = raw.trim();
  if (pattern.length === 0) return { ok: false, message: 'patterns 里不允许空字符串' };
  if (pattern.length > MAX_PATTERN_LENGTH) return { ok: false, message: `单条 pattern 最多 ${MAX_PATTERN_LENGTH} 字符` };
  // 绝对路径与分隔符：黑名单只描述"名字/扩展名"，不是路径规则（否则会误以为支持目录前缀）
  if (pattern.includes('/') || pattern.includes('\\')) return { ok: false, message: `pattern 不允许包含路径分隔符：${pattern}` };
  if (path.isAbsolute(pattern)) return { ok: false, message: `pattern 不允许是绝对路径：${pattern}` };
  return { ok: true, pattern };
}

export function validatePatterns(rawPatterns) {
  if (!Array.isArray(rawPatterns)) return { ok: false, message: 'patterns 必须是字符串数组' };
  if (rawPatterns.length > MAX_PATTERNS) return { ok: false, message: `patterns 最多 ${MAX_PATTERNS} 条` };

  const patterns = [];
  for (const raw of rawPatterns) {
    const checked = validateOnePattern(raw);
    if (!checked.ok) return checked;
    if (!patterns.includes(checked.pattern)) patterns.push(checked.pattern);
  }
  return { ok: true, patterns };
}

/**
 * 单条 pattern → 判定器。
 * 支持的三种形态（契约 §4.5「按扩展名 / 按文件名」+ 全局层里的 @eaDir 目录名）：
 *   - `*.jpg` → 扩展名（大小写不敏感；`*.gz` 也能命中 `a.tar.gz`，因为按后缀比）
 *   - `Thumbs.db` / `.DS_Store` → 精确文件名（大小写不敏感：NAS 上大小写混写很常见）
 *   - `@eaDir` → 任一路径段同名（这样 @eaDir 里的文件也一并跳过）
 * @param {string} pattern
 * @returns {{pattern: string, test: (name: string, segments: string[]) => boolean}}
 */
export function compilePattern(pattern) {
  const lowered = pattern.toLowerCase();
  if (lowered.startsWith('*.')) {
    const suffix = lowered.slice(1); // '*.jpg' → '.jpg'
    return {
      pattern,
      test: (name) => name.toLowerCase().endsWith(suffix),
    };
  }
  return {
    pattern,
    test: (name, segments) => name.toLowerCase() === lowered
      || (Array.isArray(segments) && segments.some((segment) => segment.toLowerCase() === lowered)),
  };
}

/**
 * 把三层解析成"按优先级排好的判定层"（task > user > global）。
 * 关掉的层不参与匹配；`enabled:false` 的任务级开关表示**整条黑名单不生效**（三层都跳过）。
 * @param {object} input
 * @param {{enabled?: boolean, patterns?: string[]}} [input.task] 任务级临时层（extraPatterns）
 * @param {{enabled?: boolean, patterns?: string[]}} [input.user] 用户层
 * @param {{enabled?: boolean}} [input.global] 全局层（默认开）
 * @returns {Array<{layer: string, enabled: boolean, patterns: string[]}>}
 */
export function resolveLayers({ task, user, global } = {}) {
  const layers = [];
  if (task && task.enabled !== false && Array.isArray(task.patterns) && task.patterns.length > 0) {
    layers.push({ layer: BLACKLIST_LAYERS.TASK, patterns: task.patterns });
  }
  if (user && user.enabled !== false && Array.isArray(user.patterns) && user.patterns.length > 0) {
    layers.push({ layer: BLACKLIST_LAYERS.USER, patterns: user.patterns });
  }
  if (!global || global.enabled !== false) {
    layers.push({ layer: BLACKLIST_LAYERS.GLOBAL, patterns: [...GLOBAL_PATTERNS] });
  }
  return layers;
}

/**
 * 判定一个条目。
 * @param {Array<{layer: string, patterns: string[]}>} layers resolveLayers() 的结果（已按优先级排列）
 * @param {{name: string, segments?: string[]}} entry name=文件名；segments=相对路径的各段（用于目录名规则）
 * @returns {{pattern: string, layer: string} | null} 命中返回到层与 pattern，未命中 null
 */
export function matchEntry(layers, entry) {
  if (!Array.isArray(layers) || layers.length === 0) return null;
  const name = String((entry && entry.name) || '');
  if (!name) return null;
  const segments = Array.isArray(entry.segments) ? entry.segments : [];
  for (const layer of layers) {
    for (const pattern of layer.patterns) {
      if (compilePattern(pattern).test(name, segments)) {
        return { pattern, layer: layer.layer };
      }
    }
  }
  return null;
}

/** 有效 pattern 条数（GET /blacklist 的 effectiveCount：三层去重后总数） */
export function countEffective(layers) {
  const seen = new Set();
  for (const layer of layers || []) {
    for (const pattern of layer.patterns || []) seen.add(pattern.toLowerCase());
  }
  return seen.size;
}

/**
 * 黑名单服务：持有用户层的读写（其余两层由调用方传入）。
 * 用户层落盘到 `<dataDir>/blacklist-user.json`，原子写（写坏一个文件不该让设置彻底失效）。
 */
export function createBlacklistService({ dataDir, logger }) {
  const userFile = path.join(dataDir, USER_FILE);
  let cached = null; // 懒加载缓存：GET /blacklist 与预检都可能频繁读

  /** 读用户层（缓存 + 文件；读取失败按默认值，并告警 —— 不能因为一个坏文件让压缩任务起不来） */
  async function loadUser() {
    if (cached) return cached;
    try {
      const text = await fsp.readFile(userFile, 'utf8');
      const parsed = JSON.parse(text);
      const checked = validatePatterns(parsed && parsed.patterns);
      cached = {
        enabled: parsed && parsed.enabled !== false,
        patterns: checked.ok ? checked.patterns : [],
        updatedAt: Number.isFinite(parsed && parsed.updatedAt) ? parsed.updatedAt : null,
      };
      if (!checked.ok) logger.warn('blacklist 用户层文件不合法，已按空处理', { reason: checked.message });
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn('blacklist 用户层读取失败，按默认值处理', { error: error.message });
      cached = emptyUserLayer();
    }
    return cached;
  }

  /** 全量替换用户层（幂等）；返回替换后的用户层 */
  async function replaceUser({ patterns, enabled }) {
    const checked = validatePatterns(patterns);
    if (!checked.ok) {
      const error = new Error(checked.message);
      error.validation = true;
      throw error;
    }
    const next = {
      enabled: enabled !== false,
      patterns: checked.patterns,
      updatedAt: Date.now(),
    };
    await fsp.mkdir(dataDir, { recursive: true });
    await writeJsonAtomic(userFile, { version: 1, ...next });
    cached = next;
    return next;
  }

  /** 三层快照（GET /blacklist 的 data；global 的 enabled 恒 true —— 契约 locked 表示不可改） */
  async function snapshot({ taskPatterns = [] } = {}) {
    const user = await loadUser();
    const layers = resolveLayers({
      task: { enabled: true, patterns: taskPatterns },
      user,
      global: { enabled: true },
    });
    return {
      global: { locked: true, enabled: true, patterns: [...GLOBAL_PATTERNS] },
      user: { enabled: user.enabled, patterns: [...user.patterns], updatedAt: user.updatedAt },
      effectiveCount: countEffective(layers),
    };
  }

  /** 解析出本次判定用的层（taskPatterns = 任务级临时层；enabled=false 表示整条黑名单关掉） */
  async function layersFor({ enabled = true, taskPatterns = [] } = {}) {
    if (!enabled) return [];
    const user = await loadUser();
    return resolveLayers({
      task: { enabled: true, patterns: taskPatterns },
      user,
      global: { enabled: true },
    });
  }

  return { loadUser, replaceUser, snapshot, layersFor, userFile };
}
