// 库收口漂移检查（F1.2 门禁）
//
// 目的：让「换库时改动量最小化」可落地——每个第三方库只允许在**一个收口文件**里 import，
// 其余任何地方出现该库的 import 都算「库泄漏」——换库时只需改收口点，调用方零改动。
//
// 规则表就是下面 RULES：库 → 唯一允许 import 它的文件（相对项目根）。
// 有违规 → 打印清单并以退出码 1 结束（可直接挂到 CI / 提交前检查）。
//
// 为什么用「import 语句扫描」而不是 AST：
// - 零依赖（不引解析器：为一条静态检查新增依赖不划算）；
// - .vue / .js 的 import 形态固定，正则足够；注释先剥掉避免误报；
// - 门禁的价值在于"能被已知 bug 弄红"，这一点本脚本已通过自证（注入违规 → 报红）。
//
// 退出码：0 = 通过；1 = 发现越界 import 或规则表失效（收口文件不存在）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ===== 路径（全部由脚本自身位置推导，不写死绝对路径）=====

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const SCAN_ROOT = path.join(PROJECT_ROOT, 'web', 'src');

// ===== 规则表：库 → 唯一允许 import 的文件（相对项目根，POSIX 风格）=====

const RULES = [
  {
    library: 'lucide-vue-next',
    allowed: 'web/src/components/common/Icon.vue',
    reason: '图标收口层（换图标库只改这一个文件）',
  },
  {
    library: 'uplot',
    allowed: 'web/src/components/metrics/TrendChart.vue',
    reason: '图表收口层（换图表库只改这一个文件）',
  },
  {
    library: 'axios',
    allowed: 'web/src/api/client.js',
    reason: 'HTTP 收口层（换请求库只改这一个文件）',
  },
  {
    library: 'dayjs',
    allowed: 'web/src/utils/format.js',
    reason: '时间格式化收口层',
  },
  {
    library: 'pretty-bytes',
    allowed: 'web/src/utils/format.js',
    reason: '字节格式化收口层',
  },
];

// 扫描范围：只扫前端源码；不扫 node_modules / dist（前者是依赖自身，后者是产物）
const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.vue', '.ts']);
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.vite']);

// import 形态（逐行匹配，便于给出行号）
const IMPORT_PATTERNS = [
  /^\s*import\s+[\s\S]*?from\s*['"]([^'"]+)['"]/, // import x from 'lib'
  /^\s*import\s*['"]([^'"]+)['"]/, // import 'lib'
  /^\s*export\s+[\s\S]*?from\s*['"]([^'"]+)['"]/, // export { x } from 'lib'（再导出同样是引入该库，别让它绕过门禁）
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/, // import('lib')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/, // require('lib')
];

// ===== 工具函数 =====

/** 递归收集待扫描文件（返回绝对路径数组） */
function collectFiles(dir) {
  const collected = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`无法读取目录 ${dir}：${error.message}`);
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      collected.push(...collectFiles(full));
    } else if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      collected.push(full);
    }
  }
  return collected;
}

/** 剥掉注释但保留行数（避免注释里的 import 造成误报，同时不破坏行号） */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (match, prefix) => prefix + ' '.repeat(match.length - prefix.length));
}

/** 取 import 说明符对应的包根名（支持 @scope/pkg 与子路径） */
function packageRoot(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) {
    return null; // 相对路径 / 绝对路径 / 子路径导入别名：不受本门禁约束
  }
  if (specifier.startsWith('node:')) return null;
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : segments[0];
  }
  return segments[0];
}

/** 相对项目根的 POSIX 路径（用于与规则表比对，跨平台一致） */
function toProjectRelative(absPath) {
  return path.relative(PROJECT_ROOT, absPath).split(path.sep).join('/');
}

// ===== 主流程 =====

function main() {
  // 0) 规则表自检：收口文件必须存在，否则规则已失效（换了文件名却没更新门禁 = 静默失去保护）
  const staleRules = RULES.filter((rule) => !fs.existsSync(path.join(PROJECT_ROOT, rule.allowed)));
  if (staleRules.length > 0) {
    console.error('❌ 规则表失效：以下收口文件不存在，门禁无法生效（请更新 scripts/check-drift.js 的 RULES）');
    for (const rule of staleRules) {
      console.error(`   - ${rule.library} → ${rule.allowed}（文件不存在）`);
    }
    process.exitCode = 1;
    return;
  }

  const files = collectFiles(SCAN_ROOT);
  const violations = [];
  let scannedImports = 0;

  for (const file of files) {
    const relative = toProjectRelative(file);
    const source = stripComments(fs.readFileSync(file, 'utf8'));
    const lines = source.split('\n');

    lines.forEach((line, index) => {
      for (const pattern of IMPORT_PATTERNS) {
        const match = line.match(pattern);
        if (!match) continue;
        scannedImports += 1;
        const specifier = match[1];
        const root = packageRoot(specifier);
        if (!root) continue;

        const rule = RULES.find((item) => item.library === root);
        if (!rule) continue; // 未纳入收口规则的库（含 vue / vue-router / pinia 这类框架级依赖）不拦
        if (relative === rule.allowed) continue; // 命中唯一允许的收口点

        violations.push({
          file: relative,
          line: index + 1,
          specifier,
          library: rule.library,
          allowed: rule.allowed,
          reason: rule.reason,
          snippet: line.trim(),
        });
      }
    });
  }

  // 报告
  if (violations.length > 0) {
    console.error(`❌ 库收口检查未通过：发现 ${violations.length} 处越界 import`);
    console.error('');
    for (const violation of violations) {
      console.error(`   ${violation.file}:${violation.line}  →  '${violation.specifier}'`);
      console.error(`      该库（${violation.library}）只允许在 ${violation.allowed} 中 import（${violation.reason}）`);
      console.error(`      代码：${violation.snippet}`);
      console.error('');
    }
    console.error('修复方式：不要在业务文件里直接 import 该库，改为使用对应的收口组件/模块。');
    process.exitCode = 1;
    return;
  }

  console.log('✅ 库收口检查通过：未发现越界 import');
  console.log('');
  console.log(`   扫描范围：${toProjectRelative(SCAN_ROOT)} 下 ${files.length} 个文件，共 ${scannedImports} 条 import 命中匹配`);
  console.log('   收口规则（库 → 唯一允许出现的文件）：');
  for (const rule of RULES) {
    console.log(`     - ${rule.library.padEnd(16)} → ${rule.allowed}`);
  }
  process.exitCode = 0;
}

try {
  main();
} catch (error) {
  console.error(`❌ 库收口检查执行失败：${error.message}`);
  process.exitCode = 1;
}
