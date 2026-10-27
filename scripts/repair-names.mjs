#!/usr/bin/env node
//
// CLI：批量修复目录里的乱码文件名（PUA 转义还原）
//
// 用法：
//   node scripts/repair-names.mjs --root /volume1/Download --path /某目录            # 预览（默认 dryRun）
//   node scripts/repair-names.mjs --root /volume1/Download --path /某目录 --write    # 真改
//
// 说明：
//   - 与 HTTP 端点 `POST /fs/repair-names` 走**同一份实现**（core/fs/repairNames.js），
//     不另写一套逻辑；便于在没有服务/无 token 的批处理场景使用。
//   - **默认 dryRun**：不加 --write 一律只打印清单（项目对批量改名的硬纪律）。
//   - --root 是存储根（能是共享目录本身），--path 是根内的用户路径。

import { repairNamesInDirectory } from '../server/core/fs/repairNames.js';

function parseArgs(argv) {
  const args = { dryRun: true, maxDepth: 6 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--root') args.root = argv[index += 1];
    else if (token === '--path') args.path = argv[index += 1];
    else if (token === '--max-depth') args.maxDepth = Number(argv[index += 1]);
    else if (token === '--write') args.dryRun = false;
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.root || !args.path) {
  console.log(`用法：
  node scripts/repair-names.mjs --root <存储根绝对路径> --path <根内路径> [--write] [--max-depth 6]

默认只预览（dryRun），加 --write 才真正改名。`);
  process.exit(args.help ? 0 : 1);
}

const report = await repairNamesInDirectory({ rootAbs: args.root }, {
  path: args.path,
  dryRun: args.dryRun,
  maxDepth: args.maxDepth,
});

console.log(`目录：${report.path}`);
console.log(`模式：${report.dryRun ? '预览（不改文件）' : '执行改名'}`);
console.log(`扫描：${report.scanned} 个条目${report.truncated ? '（已达上限，结果被截断）' : ''}`);
console.log(`计数：可还原 ${report.counts.candidates} / 已改名 ${report.renamed} / 撞名 ${report.counts.conflicts} / 不可还原 ${report.counts.unrecoverable}`);

if (report.candidates.length > 0) {
  console.log('\n可还原（最多列 50 条）：');
  for (const item of report.candidates) {
    console.log(`  ${item.from}\n    → ${item.to}\n    hex=${item.hex}`);
  }
}
if (report.conflicts.length > 0) {
  console.log('\n撞名跳过（目标已存在，绝不覆盖）：');
  for (const item of report.conflicts) console.log(`  ${item.from} → ${item.to}（${item.reason}）`);
}
if (report.unrecoverable.length > 0) {
  console.log('\n不可还原（有损，不猜编码）：');
  for (const item of report.unrecoverable) console.log(`  ${item.path}（${item.reason}）`);
}
if (report.dryRun && report.counts.candidates > 0) {
  console.log('\n提示：以上仅为预览。确认无误后加 --write 真正改名。');
}
