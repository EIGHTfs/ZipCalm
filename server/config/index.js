// 配置加载与校验（结构照 docs/M0/数据模型.md §八）
//
// 优先级（低 → 高）：
//   1. server/config/defaults.js 内置默认值
//   2. <项目根>/config.json          （可选，用于引导 dataDir 等）
//   3. <dataDir>/config.json         （运行期覆盖项；storage/ 已 gitignore，凭据不进库）
//   4. 环境变量白名单（ZIPCALM_*，只允许单值型部署差异）
//
// 为什么运行期配置放 <dataDir>/config.json：那里已被 .gitignore 忽略，
// 密码哈希/端口这类部署差异不会误提交（INV-16 凭据不入库）。

import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_CONFIG, ENV_OVERRIDES } from './defaults.js';
import { validateConfig } from './schema.js';
import { checkAccess, ensureDir, readJson } from '../lib/atomic-json.js';

/** 可深合并的普通对象（数组/标量/null 都不算） */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 深合并（只合并普通对象；数组/标量直接覆盖） */
function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

/** 按 ENV_OVERRIDES 把环境变量写进配置（数字型字段做类型转换，非法值记 warning 并忽略） */
function applyEnv(config, env) {
  const applied = [];
  const warnings = [];
  for (const [envKey, configPath] of Object.entries(ENV_OVERRIDES)) {
    const raw = env[envKey];
    if (raw === undefined || raw === '') continue;
    const [section, field] = configPath;
    let resolvedValue = raw;
    if (field === 'port') {
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isInteger(parsed)) {
        warnings.push(`环境变量 ${envKey} 不是整数，已忽略`);
        continue;
      }
      resolvedValue = parsed;
    }
    config[section][field] = resolvedValue;
    applied.push(`${envKey} → ${configPath.join('.')}`);
  }
  return { applied, warnings };
}

/**
 * 加载并校验配置。
 * @param {{projectRoot?: string, env?: Record<string,string>}} options
 * @returns {Promise<{config: object, projectRoot: string, warnings: string[], sources: string[]}>}
 */
export async function loadConfig(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const env = options.env || process.env;
  const warnings = [];
  const sources = [];

  // 1) 内置默认值
  let config = deepMerge({}, DEFAULT_CONFIG);

  // 2) 项目根 config.json（可选引导文件）
  const rootConfigPath = path.join(projectRoot, 'config.json');
  const rootConfig = await readJson(rootConfigPath, null);
  if (rootConfig.ok && rootConfig.data) {
    config = deepMerge(config, rootConfig.data);
    sources.push('config.json');
  }

  // 3) <dataDir>/config.json（dataDir 可能被上面引导文件改过，所以放在后面读）
  const dataDir = path.resolve(projectRoot, config.storage.dataDir);
  const runtimeConfigPath = path.join(dataDir, 'config.json');
  const runtimeConfig = await readJson(runtimeConfigPath, null);
  if (runtimeConfig.ok && runtimeConfig.data) {
    config = deepMerge(config, runtimeConfig.data);
    sources.push(path.relative(projectRoot, runtimeConfigPath));
  }

  // 4) 环境变量（部署差异）
  const envResult = applyEnv(config, env);
  warnings.push(...envResult.warnings);
  if (envResult.applied.length > 0) sources.push(`env(${envResult.applied.length} 项)`);

  // ===== 校验 =====
  const { errors, warnings: schemaWarnings } = validateConfig(config);
  warnings.push(...schemaWarnings);
  if (errors.length > 0) {
    const error = new Error(`配置校验未通过：\n${errors.map((item) => `  - ${item}`).join('\n')}`);
    error.name = 'ConfigError';
    error.errors = errors;
    throw error;
  }

  // ===== 路径绝对化 =====
  // 基准目录（项目根）只在一处决定：所有 storage 子路径都经它换算，避免四处各写一次 path.resolve
  const resolveUnderProject = (value) => path.resolve(projectRoot, value);
  const resolved = {
    ...config,
    storage: {
      ...config.storage,
      root: resolveUnderProject(config.storage.root),
      // 每个可切换根也绝对化；**不 ensureDir**（它们可能是 NAS 卷，应用无权/不该创建）
      roots: (config.storage.roots || []).map((root) => ({ ...root, path: resolveUnderProject(root.path) })),
      dataDir: resolveUnderProject(config.storage.dataDir),
      trashDir: resolveUnderProject(config.storage.trashDir),
      logDir: resolveUnderProject(config.storage.logDir),
    },
  };

  // ===== 目录准备与可访问性校验（给出明确原因，而不是启动后才发现）=====
  await ensureDir(resolved.storage.dataDir);
  await ensureDir(resolved.storage.logDir);
  await ensureDir(resolved.storage.trashDir);
  await ensureDir(resolved.storage.root);

  const rootReadWrite = await checkAccess(resolved.storage.root, fs.constants.R_OK | fs.constants.W_OK);
  if (!rootReadWrite.ok) {
    const error = new Error(`存储根不可读写：${resolved.storage.root}（${rootReadWrite.reason}）`);
    error.name = 'ConfigError';
    error.errors = ['storage.root 需要可读且可写'];
    throw error;
  }

  return { config: resolved, projectRoot, warnings, sources };
}
