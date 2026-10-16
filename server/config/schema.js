// 配置校验（零依赖，手写规则；结构照 docs/M0/数据模型.md §八）
//
// 校验分两档：
// - errors：必须修，否则启动失败（类型错、端口越界、连密码都没配…）
// - warnings：可疑但不致命（未知字段、端口是常见占用端口…），只提示
//
// 文件系统相关的检查（root 存在且可读写）在 config/index.js 里做异步校验，
// 因为本文件要保持纯函数、便于将来单测。

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

export function validateConfig(config) {
  const errors = [];
  const warnings = [];

  const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const requireObject = (section) => {
    if (!isPlainObject(config[section])) {
      errors.push(`配置段 ${section} 必须是对象`);
      return false;
    }
    return true;
  };

  // ===== server =====
  if (requireObject('server')) {
    const { host, port } = config.server;
    if (typeof host !== 'string' || host.length === 0) errors.push('server.host 必须是非空字符串');
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('server.port 必须是 1~65535 的整数');
  }

  // ===== auth =====
  if (requireObject('auth')) {
    const { username, password, passwordHash, sessionTtlMs, tokenTtlMs, cookieName, loginRateLimit } = config.auth;
    if (typeof username !== 'string' || username.length === 0) errors.push('auth.username 必须是非空字符串');
    if (!password && !passwordHash) {
      errors.push('auth 必须配置 passwordHash（推荐）或 password 其中之一');
    }
    if (passwordHash && !/^scrypt\$/.test(String(passwordHash))) {
      warnings.push('auth.passwordHash 不是本项目的 scrypt$ 格式，可能无法通过校验（请用 scripts/hash-password.js 生成）');
    }
    if (!Number.isInteger(sessionTtlMs) || sessionTtlMs <= 0) errors.push('auth.sessionTtlMs 必须是正整数');
    if (!Number.isInteger(tokenTtlMs) || tokenTtlMs <= 0) errors.push('auth.tokenTtlMs 必须是正整数');
    if (typeof cookieName !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cookieName)) {
      errors.push('auth.cookieName 只能是字母数字下划线连字符');
    }
    if (!isPlainObject(loginRateLimit) || !Number.isInteger(loginRateLimit.max) || !Number.isInteger(loginRateLimit.windowMs)) {
      errors.push('auth.loginRateLimit 需要 { max, windowMs } 两个整数');
    }
  }

  // ===== storage =====
  if (requireObject('storage')) {
    const { root, dataDir, trashDir, logDir } = config.storage;
    for (const [key, value] of Object.entries({ root, dataDir, trashDir, logDir })) {
      if (typeof value !== 'string' || value.length === 0) errors.push(`storage.${key} 必须是非空字符串`);
    }
    // 防呆：存储根不允许直接指向文件系统根，否则白名单形同虚设（INV-06）
    if (typeof root === 'string' && (root === '/' || /^[A-Za-z]:[\\/]?$/.test(root))) {
      errors.push('storage.root 不允许指向文件系统根（会让路径白名单失去意义）');
    }
  }

  // ===== limits =====
  if (requireObject('limits')) {
    const { maxPathLength, maxPathSegmentLength, maxListEntries, defaultPageSize } = config.limits;
    if (!Number.isInteger(maxPathLength) || maxPathLength < 64) errors.push('limits.maxPathLength 必须是 ≥64 的整数');
    if (!Number.isInteger(maxPathSegmentLength) || maxPathSegmentLength < 16 || maxPathSegmentLength > 4096) {
      errors.push('limits.maxPathSegmentLength 必须是 16~4096 的整数（单段长度上限，POSIX 常见值 255）');
    }
    if (Number.isInteger(maxPathSegmentLength) && Number.isInteger(maxPathLength) && maxPathSegmentLength > maxPathLength) {
      errors.push('limits.maxPathSegmentLength 不能大于 limits.maxPathLength');
    }
    if (!Number.isInteger(maxListEntries) || maxListEntries < 1) errors.push('limits.maxListEntries 必须是正整数');
    if (!Number.isInteger(defaultPageSize) || defaultPageSize < 1) errors.push('limits.defaultPageSize 必须是正整数');
  }

  // ===== log =====
  if (requireObject('log')) {
    if (!LOG_LEVELS.includes(config.log.level)) {
      errors.push(`log.level 必须是 ${LOG_LEVELS.join(' / ')} 之一`);
    }
  }

  // ===== 未知字段提示（向前兼容：只警告不拦截）=====
  const knownSections = ['server', 'auth', 'storage', 'limits', 'log'];
  for (const key of Object.keys(config)) {
    if (!knownSections.includes(key)) warnings.push(`配置里存在未知段 ${key}（M1 未使用，可能是以后里程碑的配置）`);
  }

  return { errors, warnings };
}
