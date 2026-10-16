// 结构化日志（零依赖，JSON Lines）
//
// 设计要点：
// - 每行一个 JSON 对象，方便将来直接喂给日志分析；不需要引入 pino/winston。
// - **脱敏是硬要求**（INV-16：凭据不落明文）：字段名命中敏感词的一律替换为 [redacted]，
//   且请求日志只记 method/url/status/耗时，不记 Cookie/Authorization 内容。
// - 级别过滤用配置里的 log.level（debug|info|warn|error）。

const LEVEL_WEIGHT = { debug: 10, info: 20, warn: 30, error: 40 };

// 命中即脱敏的字段名（大小写不敏感，包含匹配）
const SENSITIVE_KEY_PATTERN = /(password|passwd|token|authorization|cookie|secret|credential|apikey|api_key)/i;

/**
 * 递归脱敏：对象里的敏感字段替换为 [redacted]（数组按元素处理，深度上限 6 层防环）。
 */
export function redact(value, depth = 0) {
  if (depth > 6) return '[deep]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[redacted]' : redact(val, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * 创建 logger。
 * @param {{level?: string, stream?: NodeJS.WritableStream, bindings?: object}} options
 */
export function createLogger(options = {}) {
  const level = LEVEL_WEIGHT[options.level] ? options.level : 'info';
  const stream = options.stream || process.stdout;
  const bindings = options.bindings || {};
  const threshold = LEVEL_WEIGHT[level];

  function write(entryLevel, message, context) {
    if (LEVEL_WEIGHT[entryLevel] < threshold) return;
    const line = {
      ts: new Date().toISOString(),
      level: entryLevel,
      msg: String(message),
      ...redact(bindings),
      ...(context ? redact(context) : {}),
    };
    try {
      stream.write(`${JSON.stringify(line)}\n`);
    } catch {
      // 日志写不出去也不能影响业务
    }
  }

  const logger = {
    level,
    debug: (msg, ctx) => write('debug', msg, ctx),
    info: (msg, ctx) => write('info', msg, ctx),
    warn: (msg, ctx) => write('warn', msg, ctx),
    error: (msg, ctx) => write('error', msg, ctx),
    /** 绑定固定字段（如 module 名） */
    child(extra) {
      return createLogger({ ...options, level, stream, bindings: { ...bindings, ...extra } });
    },
  };
  return logger;
}
