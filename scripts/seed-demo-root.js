#!/usr/bin/env node
//
// 生成演示目录树（放在存储根下，用于联调/验收）
//
// 用法：
//   node scripts/seed-demo-root.js              # 用默认根 <项目根>/storage/fs-root
//   node scripts/seed-demo-root.js /some/path   # 指定根
//   ZIPCALM_STORAGE_ROOT=/some/path node scripts/seed-demo-root.js
//
// 特性：幂等——已存在的条目跳过并报告；不会删除任何东西。
// 注意：storage/ 已在 .gitignore 中，这些是运行期演示数据，不入库。

import fs from 'node:fs/promises';

import { PROJECT_ROOT } from './helpers/script-env.mjs';
import path from 'node:path';

/** 假二进制文件的填充字节（'Z'：肉眼可辨，且不是 0/0xFF 这类容易被误判的填充） */
const DEMO_FILL_BYTE = 0x5a;
/** 演示文件的假尺寸（字节）：只为让列表里的"大小"列有可辨认的样本，不是任何业务阈值 */
const DEMO_PHOTO_JPG_BYTES = 1200;
const DEMO_PHOTO_PNG_BYTES = 800;
const DEMO_ARCHIVE_BYTES = 2048;
const ROOT = path.resolve(
  process.argv[2] || process.env.ZIPCALM_STORAGE_ROOT || path.join(PROJECT_ROOT, 'storage', 'fs-root'),
);

const created = [];
const skipped = [];

/** 写文件（已存在则跳过） */
async function writeFileIfAbsent(relPath, content) {
  const target = path.join(ROOT, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.access(target);
    skipped.push(relPath);
  } catch {
    await fs.writeFile(target, content);
    created.push(relPath);
  }
}

/** 建目录（已存在则跳过） */
async function mkdirIfAbsent(relPath) {
  const target = path.join(ROOT, relPath);
  try {
    await fs.access(target);
    skipped.push(`${relPath}/`);
  } catch {
    await fs.mkdir(target, { recursive: true });
    created.push(`${relPath}/`);
  }
}

/** 建符号链接：inner 指向根内（应可进入），escape 指向根外（必须被白名单拦下） */
async function symlinkIfAbsent(relPath, target) {
  const linkPath = path.join(ROOT, relPath);
  try {
    await fs.lstat(linkPath);
    skipped.push(`${relPath} -> ${target}`);
  } catch {
    await fs.symlink(target, linkPath);
    created.push(`${relPath} -> ${target}`);
  }
}

/** 生成确定长度的假二进制内容（用于验证列表里的大小显示） */
function fakeBytes(size, seedText) {
  const header = Buffer.from(`ZipCalm demo file: ${seedText}\n`);
  const body = Buffer.alloc(Math.max(0, size - header.length), DEMO_FILL_BYTE);
  return Buffer.concat([header, body]);
}

async function main() {
  await fs.mkdir(ROOT, { recursive: true });

  await mkdirIfAbsent('文档');
  await mkdirIfAbsent('图片');
  await mkdirIfAbsent('备份');
  await mkdirIfAbsent('文档/子目录');
  await mkdirIfAbsent('.隐藏目录');

  await writeFileIfAbsent('说明.txt', 'ZipCalm 演示根目录：用于验证「登录 → 浏览目录 → 进入子目录」链路。\n');
  await writeFileIfAbsent('文档/readme.txt', '这是一个用于演示的文本文件。\n第二行。\n');
  await writeFileIfAbsent('文档/notes.md', '# 笔记\n\n- 支持多格式压缩（M2 起）\n- 黑名单智能跳过（M6）\n');
  await writeFileIfAbsent('文档/子目录/深层文件.log', 'deep file for path testing\n');
  await writeFileIfAbsent('图片/photo-a.jpg', fakeBytes(DEMO_PHOTO_JPG_BYTES, 'photo-a'));
  await writeFileIfAbsent('图片/photo-b.png', fakeBytes(DEMO_PHOTO_PNG_BYTES, 'photo-b'));
  await writeFileIfAbsent('备份/old-archive.zip', fakeBytes(DEMO_ARCHIVE_BYTES, 'old-archive'));
  await writeFileIfAbsent('.隐藏目录/secret.txt', 'hidden by default（showHidden=true 才返回）\n');

  // 根内链接：进入应该成功
  await symlinkIfAbsent('文档-链接', path.join(ROOT, '文档'));
  // 根外链接：进入必须 403 PATH_OUT_OF_ROOT（INV-06 第 9 条）
  await symlinkIfAbsent('越界-链接', PROJECT_ROOT);

  process.stdout.write(`存储根：${ROOT}\n`);
  process.stdout.write(`新建 ${created.length} 项：\n${created.map((item) => `  + ${item}`).join('\n') || '  （无）'}\n`);
  process.stdout.write(`已存在跳过 ${skipped.length} 项：\n${skipped.map((item) => `  = ${item}`).join('\n') || '  （无）'}\n`);
}

main().catch((error) => {
  process.stderr.write(`生成演示目录失败：${error.message}\n`);
  process.exit(1);
});
