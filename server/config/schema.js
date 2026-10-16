// 配置校验（零依赖，手写规则；结构照 docs/M0/数据模型.md §八）
//
// 校验分两档：
// - errors：必须修，否则启动失败（类型错、端口越界、连密码都没配…）
// - warnings：可疑但不致命（未知字段、删除模式回落…），只提示
//
// 文件系统相关的检查（root 存在且可读写）在 config/index.js 里做异步校验，
// 因为本文件要保持纯函数、便于单测。
//
// 结构说明：**每个配置区块一个校验函数**（server / auth / storage / limits / compress / delete / log），
// 主函数 validateConfig 只负责按序调用并汇总结果 —— 这样单块规则好读、好测，也不会堆成一个巨型 if。

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

/** 本版本认识的配置段（用于"未知段"告警；新增区块时同步这里） */
const KNOWN_SECTIONS = ['server', 'auth', 'storage', 'limits', 'compress', 'delete', 'log'];

const SEGMENT_LENGTH_MIN = 16;
const SEGMENT_LENGTH_MAX = 4096;

/** 普通对象判断（数组/null 都不算） */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 区块存在性检查：不是对象就记错误（后续细项校验直接跳过，避免刷屏与 TypeError）。
 * @returns {boolean} 该区块是否可用于细项校验
 */
function requireSection(config, section, errors) {
  if (!isPlainObject(config[section])) {
    errors.push(`配置段 ${section} 必须是对象`);
    return false;
  }
  return true;
}

// ===== 各区块校验 =====

function validateServer(config, errors) {
  if (!requireSection(config, 'server', errors)) return;
  const { host, port } = config.server;
  if (typeof host !== 'string' || host.length === 0) errors.push('server.host 必须是非空字符串');
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('server.port 必须是 1~65535 的整数');
}

/** 账号与口令相关校验（用户名 / passwordHash 或 password / 哈希格式） */
function validateAuthCredentials(auth, errors, warnings) {
  const { username, password, passwordHash } = auth;
  if (typeof username !== 'string' || username.length === 0) errors.push('auth.username 必须是非空字符串');
  if (!password && !passwordHash) errors.push('auth 必须配置 passwordHash（推荐）或 password 其中之一');
  if (passwordHash && !/^scrypt\$/.test(String(passwordHash))) {
    warnings.push('auth.passwordHash 不是本项目的 scrypt$ 格式，可能无法通过校验（请用 scripts/hash-password.js 生成）');
  }
}

/** 会话/令牌与登录限流相关校验 */
function validateAuthTokens(auth, errors) {
  const { sessionTtlMs, tokenTtlMs, cookieName, loginRateLimit } = auth;
  if (!Number.isInteger(sessionTtlMs) || sessionTtlMs <= 0) errors.push('auth.sessionTtlMs 必须是正整数');
  if (!Number.isInteger(tokenTtlMs) || tokenTtlMs <= 0) errors.push('auth.tokenTtlMs 必须是正整数');
  if (typeof cookieName !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cookieName)) {
    errors.push('auth.cookieName 只能是字母数字下划线连字符');
  }
  if (!isPlainObject(loginRateLimit) || !Number.isInteger(loginRateLimit.max) || !Number.isInteger(loginRateLimit.windowMs)) {
    errors.push('auth.loginRateLimit 需要 { max, windowMs } 两个整数');
  }
}

function validateAuth(config, errors, warnings) {
  if (!requireSection(config, 'auth', errors)) return;
  validateAuthCredentials(config.auth, errors, warnings);
  validateAuthTokens(config.auth, errors);
}

function validateStorage(config, errors) {
  if (!requireSection(config, 'storage', errors)) return;
  const { root, dataDir, trashDir, logDir } = config.storage;

  for (const [key, value] of Object.entries({ root, dataDir, trashDir, logDir })) {
    if (typeof value !== 'string' || value.length === 0) errors.push(`storage.${key} 必须是非空字符串`);
  }
  // 防呆：存储根不允许直接指向文件系统根，否则白名单形同虚设（INV-06）
  if (typeof root === 'string' && (root === '/' || /^[A-Za-z]:[\\/]?$/.test(root))) {
    errors.push('storage.root 不允许指向文件系统根（会让路径白名单失去意义）');
  }
}

/** 路径长度相关（含两者之间的相对关系） */
function validatePathLimits(limits, errors) {
  const { maxPathLength, maxPathSegmentLength } = limits;
  if (!Number.isInteger(maxPathLength) || maxPathLength < 64) errors.push('limits.maxPathLength 必须是 ≥64 的整数');
  if (
    !Number.isInteger(maxPathSegmentLength)
    || maxPathSegmentLength < SEGMENT_LENGTH_MIN
    || maxPathSegmentLength > SEGMENT_LENGTH_MAX
  ) {
    errors.push('limits.maxPathSegmentLength 必须是 16~4096 的整数（单段长度上限，POSIX 常见值 255）');
  }
  if (Number.isInteger(maxPathSegmentLength) && Number.isInteger(maxPathLength) && maxPathSegmentLength > maxPathLength) {
    errors.push('limits.maxPathSegmentLength 不能大于 limits.maxPathLength');
  }
}

/** 列表与分页相关 */
function validateListLimits(limits, errors) {
  const { maxListEntries, defaultPageSize } = limits;
  if (!Number.isInteger(maxListEntries) || maxListEntries < 1) errors.push('limits.maxListEntries 必须是正整数');
  if (!Number.isInteger(defaultPageSize) || defaultPageSize < 1) errors.push('limits.defaultPageSize 必须是正整数');
}

/** 任务活动记录保留策略 */
function validateTaskRetentionLimits(limits, errors) {
  const { taskRetentionMax, taskRetentionDays } = limits;
  if (!Number.isInteger(taskRetentionMax) || taskRetentionMax < 1) {
    errors.push('limits.taskRetentionMax 必须是 ≥1 的整数');
  }
  if (typeof taskRetentionDays !== 'number' || Number.isNaN(taskRetentionDays) || taskRetentionDays <= 0) {
    errors.push('limits.taskRetentionDays 必须是正数（天，可小数）');
  }
}

function validateLimits(config, errors) {
  if (!requireSection(config, 'limits', errors)) return;
  const limits = config.limits;
  validatePathLimits(limits, errors);
  validateListLimits(limits, errors);
  validateTaskRetentionLimits(limits, errors);
}

function validateCompress(config, errors) {
  if (!requireSection(config, 'compress', errors)) return;
  const { defaultFormat, defaultMode, defaultLevel, preflightFactor } = config.compress;

  if (typeof defaultFormat !== 'string' || defaultFormat.length === 0) errors.push('compress.defaultFormat 必须是非空字符串');
  if (!['single', 'bundle'].includes(defaultMode)) errors.push('compress.defaultMode 只能是 single 或 bundle');
  if (!Number.isInteger(defaultLevel) || defaultLevel < 0 || defaultLevel > 19) errors.push('compress.defaultLevel 必须是 0~19 的整数');
  // INV-07：2 倍是底线，配置不允许把它调小
  if (!Number.isInteger(preflightFactor) || preflightFactor < 2) {
    errors.push('compress.preflightFactor 必须是 ≥2 的整数（INV-07：剩余空间 ≥ 待压 × 2）');
  }
}

function validateDelete(config, warnings) {
  if (!requireSection(config, 'delete', [])) return;
  const { mode } = config.delete;
  // 契约：未知值只告警并回落 log-only（回落动作由删除服务执行），这里不拦
  if (!['log-only', 'trash'].includes(mode)) {
    warnings.push(`delete.mode 只能是 log-only 或 trash，当前 "${String(mode)}" 将回落为 log-only`);
  }
}

function validateLog(config, errors) {
  if (!requireSection(config, 'log', errors)) return;
  if (!LOG_LEVELS.includes(config.log.level)) {
    errors.push(`log.level 必须是 ${LOG_LEVELS.join(' / ')} 之一`);
  }
}

/** 未知段只警告不拦截（向前兼容：以后新增区块时不至于启动失败） */
function warnUnknownSections(config, warnings) {
  for (const key of Object.keys(config)) {
    if (!KNOWN_SECTIONS.includes(key)) {
      warnings.push(`配置里存在未知段 ${key}（当前版本未使用，可能是以后里程碑的配置）`);
    }
  }
}

/**
 * 校验配置。
 * @param {object} config 待校验配置（已合并默认值/文件/env）
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];

  validateServer(config, errors);
  validateAuth(config, errors, warnings);
  validateStorage(config, errors);
  validateLimits(config, errors);
  validateCompress(config, errors);
  validateDelete(config, warnings);
  validateLog(config, errors);
  warnUnknownSections(config, warnings);

  return { errors, warnings };
}
