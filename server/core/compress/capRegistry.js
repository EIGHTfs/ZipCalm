// 能力注册表（docs/19 §三/§五 图 1：扫 capabilities/<id>/index.js）
//
// 照 registry.js 的模式：
// - 自动发现：扫描 server/plugins/capabilities/<id>/index.js；
// - 启动校验：必需成员/方法齐全；**不合规只禁用该包并告警，不影响其他包**；
// - 额外对账：appliesTo 声明的格式 id 必须存在于格式注册表（双向声明任一方缺失即不生效，
//   docs/19 §4.2——避免「格式说支持但能力没实现」或反之）；
// - 运行时重扫：目录 mtime 变化即重扫（与 registry 一致，加能力包零改动生效）。
//
// 与 registry 的差异：能力不参与「按扩展名匹配」，索引只有 id；
// 查询口径是「某格式启用的能力集合」= 格式 capabilities ∩ 能力 appliesTo ∩ 能力已加载。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CAPABILITY_IDS } from '../../../shared/capabilities.js';

const DEFAULT_CAPS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../plugins/capabilities',
);

/** 能力契约必需成员（docs/19 §4.2） */
const REQUIRED_MEMBERS = ['id', 'name', 'appliesTo', 'params'];
const REQUIRED_METHODS = ['validateParams', 'prepareCreate', 'verify', 'prepareExtract', 'redact'];

function validateCapability(cap, source) {
  const problems = [];
  for (const member of REQUIRED_MEMBERS) {
    if (cap[member] === undefined) problems.push(`缺少成员 ${member}`);
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof cap[method] !== 'function') problems.push(`缺少方法 ${method}()`);
  }
  if (Array.isArray(cap.appliesTo) === false) problems.push('appliesTo 必须是数组');
  if (problems.length > 0) {
    return { ok: false, reason: `${source}: ${problems.join('；')}` };
  }
  return { ok: true };
}

export function createCapabilityRegistry(options = {}) {
  const logger = options.logger || { info() {}, warn() {} };
  const capsDir = options.capsDir || DEFAULT_CAPS_DIR;
  /** 格式 id 列表（对账用；由 orchestrator/启动流程喂进来或用 isFormatKnown 动态查） */
  const knownFormatIds = new Set(options.formatIds || []);
  const byId = new Map();
  const loadFailures = [];
  let lastScanMtimeMs = 0;

  /** 已加载能力 ∩ 已声明该能力的格式 ∩ 能力 appliesTo → 三方交集查询 */
  function capabilitiesForFormat(formatId) {
    const result = [];
    for (const cap of byId.values()) {
      if (Array.isArray(cap.appliesTo) && cap.appliesTo.includes(formatId)) result.push(cap);
    }
    return result;
  }

  /**
   * 校验「格式声明了能力但能力不存在/不适用」——PW-4 的数据面：后端独立判定。
   * 返回 {ok, reason?}；格式未声明任何能力 → ok（能力交集为空，装配循环自然跳过）。
   */
  function checkFormatCapabilities(plugin) {
    const declared = plugin.capabilities || [];
    for (const capId of declared) {
      const cap = byId.get(capId);
      if (!cap) return { ok: false, reason: `格式 ${plugin.id} 声明的能力 ${capId} 未加载` };
      if (!cap.appliesTo.includes(plugin.id)) {
        return { ok: false, reason: `能力 ${capId} 不适用于格式 ${plugin.id}` };
      }
    }
    return { ok: true };
  }

  async function rescan() {
    let dirStat;
    try {
      dirStat = await fs.stat(capsDir);
    } catch {
      return; // 目录不存在 = 尚无任何能力插件（合法状态）
    }
    if (dirStat.mtimeMs === lastScanMtimeMs && byId.size > 0) return; // 无变化
    lastScanMtimeMs = dirStat.mtimeMs;

    byId.clear();
    let entries;
    try {
      entries = await fs.readdir(capsDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!CAPABILITY_IDS.includes(entry.name)) continue; // 白名单外不加载（未知能力不静默启用）
      const source = path.join(capsDir, entry.name, 'index.js');
      try {
        const module = await import(`${source}?t=${Date.now()}`);
        const cap = module.default;
        const verdict = validateCapability(cap, source);
        if (!verdict.ok) {
          loadFailures.push(verdict.reason);
          logger.warn('capability plugin rejected', { reason: verdict.reason });
          continue;
        }
        // 对账：appliesTo 里的格式如果已知名单里没有，记告警（格式包可能还没装）
        for (const formatId of cap.appliesTo) {
          if (knownFormatIds.size > 0 && !knownFormatIds.has(formatId)) {
            logger.warn('能力 appliesTo 指向未知格式（对账告警，不阻止加载）', { capability: cap.id, formatId });
          }
        }
        byId.set(cap.id, cap);
      } catch (error) {
        loadFailures.push(`${source}: ${error.message}`);
        logger.warn('capability plugin rejected', { reason: `${source}: ${error.message}` });
      }
    }
    if (loadFailures.length > 0) logger.warn('capability registry load failures', { count: loadFailures.length });
  }

  /**
   * 落盘脱敏（PW-1）：遍历任务 options.capabilities，用各能力的 redact() 剔除 secret
   * 字段（明文永不落 tasks.json）。manager 不认识具体能力，由 registry 提供通用剥离器。
   * 能力未加载但参数还在（重启后重试场景）→ 保留方法名等非敏感字段，剔除 password。
   */
  function sanitizeOptionsForPersist(options) {
    if (!options) return options;
    // P4：解压侧的顶层 options.password 同样是明文（PW-1）——落盘时替换为 hasPassword 布尔
    const hasTopPassword = typeof options.password === 'string' && options.password.length > 0;
    const caps = options.capabilities;
    if (!caps || typeof caps !== 'object') {
      if (!hasTopPassword) return options;
      const { password: _removed, ...rest } = options;
      return { ...rest, hasPassword: true };
    }
    const sanitized = { ...options, capabilities: {} };
    for (const [capId, params] of Object.entries(caps)) {
      const cap = byId.get(capId);
      if (cap && typeof cap.redact === 'function') {
        sanitized.capabilities[capId] = cap.redact(params);
        continue;
      }
      const filtered = {};
      for (const [key, value] of Object.entries(params || {})) {
        const isSecret = Boolean(value) && (key === 'password' || key === 'value');
        if (!isSecret) filtered[key] = value;
      }
      sanitized.capabilities[capId] = filtered;
    }
    if (hasTopPassword) {
      delete sanitized.password;
      sanitized.hasPassword = true;
    }
    return sanitized;
  }

  return {
    /** 启动/变更时重扫（幂等） */
    rescan,
    /** 查某格式启用的能力集合（已加载 ∩ appliesTo；格式自己的 capabilities 声明由调用方用 checkFormatCapabilities 校验） */
    capabilitiesForFormat,
    checkFormatCapabilities,
    /** PW-1：任务落盘前的通用脱敏器（剔除 capabilities 里的 secret 字段） */
    sanitizeOptionsForPersist,
    /** 能力元数据（给 GET /capabilities/:id：脱敏字段描述 + methods 动态列表） */
    get: (id) => byId.get(id) || null,
    list: () => [...byId.values()],
    loadFailures: () => [...loadFailures],
  };
}
