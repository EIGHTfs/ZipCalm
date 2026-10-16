// 格式注册表（M2：先只 zip；M4 扩展四格式时**只需加目录**，不改本文件）
//
// 契约（docs/M0/插件契约.md §五）：
// - 自动发现：扫描 server/plugins/formats/<id>/index.js；
// - 双索引：按 id 与按**每个扩展名**（含 extAliases）建索引；
// - 匹配优先级：最长复合扩展名优先（.tar.gz 不能被 .gz 抢走）；
// - 启动校验：id/ext 唯一 + 必需方法齐全；**不合规只禁用该包并告警，不影响其他包**；
// - 可用性结果缓存 ≤ 60s（用户现场装了 zstd 之类，最多一分钟 UI 就该亮起来）。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ERROR_CODES, apiError } from '../../lib/errors.js';

const DEFAULT_PLUGINS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../plugins/formats',
);

const AVAILABILITY_TTL_MS = 60 * 1000;
/** 被拒格式包的统一日志文案（三处拒绝原因共用，避免文案漂移） */
const REJECTED_LOG = 'format plugin rejected';

/** 契约要求的必需成员 */
const REQUIRED_MEMBERS = ['id', 'name', 'ext', 'mime'];
const REQUIRED_METHODS = ['available', 'estimate', 'create', 'extract', 'list', 'test'];

function validatePlugin(plugin, source) {
  const problems = [];
  for (const member of REQUIRED_MEMBERS) {
    if (typeof plugin[member] !== 'string' || plugin[member].length === 0) problems.push(`缺少字符串元数据 ${member}`);
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof plugin[method] !== 'function') problems.push(`缺少方法 ${method}()`);
  }
  if (typeof plugin.ext === 'string' && !plugin.ext.startsWith('.')) problems.push('ext 必须以 . 开头');
  if (problems.length > 0) {
    return { ok: false, reason: `${source}: ${problems.join('；')}` };
  }
  return { ok: true };
}

export function createRegistry(options = {}) {
  const logger = options.logger || { info() {}, warn() {} };
  const pluginsDir = options.pluginsDir || DEFAULT_PLUGINS_DIR;

  /** Map<id, plugin> */
  const byId = new Map();
  /** Map<ext(lowercase), plugin> */
  const byExt = new Map();
  /** 扩展名按长度降序（最长优先匹配） */
  let extKeysDesc = [];
  /** Map<id, {available:boolean, at:number}> —— 可用性探测结果（60 秒内复用，避免每次列格式都探测） */
  const availabilityCache = new Map();
  const loadFailures = [];
  /** 插件目录上次扫描时的 mtime：用于「加/删一个目录即注册」的运行时重扫 */
  let lastScanMtimeMs = 0;

  /**
   * 目录内容变化时重扫（"新增一个格式 = 新增一个目录"的运行时支撑）。
   * 目录 mtime 在增删子项时会变；没有变化就直接跳过，代价只有一次 stat。
   * @returns {Promise<boolean>} 是否真的重扫了
   */
  async function refreshIfChanged() {
    try {
      const stat = await fs.stat(pluginsDir);
      if (stat.mtimeMs === lastScanMtimeMs) return false;
      lastScanMtimeMs = stat.mtimeMs;
      await discover();
      return true;
    } catch (error) {
      logger.warn('format plugins dir stat failed', { dir: pluginsDir, error: error.message });
      return false;
    }
  }

  /** 扫描插件目录并注册 */
  async function discover() {
    byId.clear();
    byExt.clear();
    extKeysDesc = [];
    loadFailures.length = 0;

    let dirents;
    try {
      dirents = await fs.readdir(pluginsDir, { withFileTypes: true });
    } catch (error) {
      logger.warn('format plugins dir unreadable', { dir: pluginsDir, error: error.message });
      return { loaded: 0, failed: 0 };
    }

    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      // `_shared` 之类的下划线目录是内部共享代码目录，不是格式包（约定：格式包 id 不用下划线打头）
      if (dirent.name.startsWith('_')) continue;
      const source = `plugins/formats/${dirent.name}`;
      const entryFile = path.join(pluginsDir, dirent.name, 'index.js');
      let plugin;
      try {
        const module = await import(pathToFileURL(entryFile).href);
        plugin = module.default || module.plugin || module;
      } catch (error) {
        loadFailures.push(`${source}: 加载失败 ${error.message}`);
        logger.warn('format plugin import failed', { source, error: error.message });
        continue;
      }

      const valid = validatePlugin(plugin, source);
      if (!valid.ok) {
        loadFailures.push(valid.reason);
        logger.warn(REJECTED_LOG, { source, reason: valid.reason });
        continue;
      }

      // id / ext 全局唯一：冲突时禁用后来者（不影响已注册的包）
      if (byId.has(plugin.id)) {
        loadFailures.push(`${source}: id 与已注册格式冲突（${plugin.id}）`);
        logger.warn(REJECTED_LOG, { source, reason: `id 冲突 ${plugin.id}` });
        continue;
      }
      const exts = [plugin.ext, ...(Array.isArray(plugin.extAliases) ? plugin.extAliases : [])].map((ext) => ext.toLowerCase());
      const extConflict = exts.find((ext) => byExt.has(ext));
      if (extConflict) {
        loadFailures.push(`${source}: 扩展名与已注册格式冲突（${extConflict}）`);
        logger.warn(REJECTED_LOG, { source, reason: `扩展名冲突 ${extConflict}` });
        continue;
      }

      byId.set(plugin.id, plugin);
      for (const ext of exts) byExt.set(ext, plugin);
    }

    extKeysDesc = [...byExt.keys()].sort((a, b) => b.length - a.length);
    // 记下本次扫描时的目录 mtime，供 refreshIfChanged 判断"有没有增删过"
    try {
      lastScanMtimeMs = (await fs.stat(pluginsDir)).mtimeMs;
    } catch {
      lastScanMtimeMs = 0;
    }
    const loadedFormatIds = [...byId.keys()];
    logger.info('format registry loaded', { formats: loadedFormatIds, failures: loadFailures.length });
    return { loaded: byId.size, failed: loadFailures.length };
  }

  /** 可用性（带 60s 缓存） */
  async function isAvailable(id) {
    const plugin = byId.get(id);
    if (!plugin) return false;
    const cached = availabilityCache.get(id);
    if (cached && Date.now() - cached.at < AVAILABILITY_TTL_MS) return cached.available;

    let probeResult = false;
    try {
      probeResult = Boolean(await plugin.available());
    } catch (error) {
      logger.warn('format availability probe failed', { id, error: error.message });
      probeResult = false;
    }
    availabilityCache.set(id, { available: probeResult, at: Date.now() });
    return probeResult;
  }

  /** 供 API /formats 使用 */
  async function list() {
    // 每次列格式前先看看插件目录有没有增删（放一个目录进去就能出现，不需要改注册代码、也不需要重启）
    await refreshIfChanged();
    const formatItems = [];
    for (const plugin of byId.values()) {
      const available = await isAvailable(plugin.id);
      let unavailableReason = null;
      if (!available && typeof plugin.unavailableReason === 'function') {
        try {
          unavailableReason = await plugin.unavailableReason();
        } catch {
          unavailableReason = null;
        }
      }
      formatItems.push({
        id: plugin.id,
        name: plugin.name,
        ext: plugin.ext,
        extAliases: plugin.extAliases || [],
        mime: plugin.mime,
        available,
        unavailableReason,
        levelRange: plugin.levelRange || null,
        defaultLevel: plugin.defaultLevel ?? null,
      });
    }
    return formatItems;
  }

  function get(id) {
    return byId.get(id) || null;
  }

  /** 取插件；取不到抛契约错误码（调用方不用自己拼错） */
  function require(id) {
    const plugin = byId.get(id);
    if (!plugin) {
      throw apiError(ERROR_CODES.UNSUPPORTED_FORMAT, `不支持的压缩格式：${id}`, { supported: [...byId.keys()] });
    }
    return plugin;
  }

  /** 按扩展名取插件（最长优先）；找不到返回 null */
  function byExtension(ext) {
    if (typeof ext !== 'string' || ext === '') return null;
    const lower = ext.toLowerCase();
    for (const candidate of extKeysDesc) {
      if (lower === candidate || lower.endsWith(candidate)) return byExt.get(candidate);
    }
    return null;
  }

  return {
    discover,
    refreshIfChanged,
    list,
    get,
    require,
    byExtension,
    isAvailable,
    ids: () => [...byId.keys()],
    failures: () => [...loadFailures],
  };
}
