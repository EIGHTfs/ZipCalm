// 源 → 文件清单（黑名单预览 / 压缩预检 / 打包收集 三处共用同一套遍历口径）
//
// 为什么必须共用：黑名单要判断"哪些文件会被跳过"，预检要算"实际待压字节"，打包要真的不放进包。
// 这三件事若各写一份遍历，就会漂移成"预检说 3 个跳过、打包跳过了 5 个"——那是最难查的一类 bug。
//
// 口径（与格式包 create() 的条目收集保持一致）：
// - 目录递归；**不跟随符号链接**（符号链接本来就不进包，由各格式包的 skippedSymlinks 统计）
// - 只看普通文件；目录本身不参与黑名单匹配（目录名匹配通过路径段 segments 实现，如 @eaDir）
// - 返回的 relative 用 POSIX 分隔符（对外路径统一用 /）

import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * 列出 absPath 下的普通文件（absPath 本身就是文件时返回它自己）。
 *
 * `dev` / `ino` 一并返回：硬链接判定（同 dev 且同 ino 才是硬链接）与压缩格式的产出估算
 * 都要用，而它们本来就在这次 lstat 结果里 —— 不额外多一次 syscall。
 *
 * @param {string} absPath
 * @returns {Promise<Array<{absPath: string, name: string, relative: string, segments: string[], size: number, dev: number|null, ino: number|null}>>}
 */
export async function collectFilesUnder(absPath) {
  const stat = await fsp.lstat(absPath).catch(() => null);
  if (!stat) return [];
  if (stat.isFile()) {
    return [{
      absPath,
      name: path.basename(absPath),
      relative: '',
      segments: [],
      size: stat.size,
      dev: Number.isFinite(stat.dev) ? stat.dev : null,
      ino: Number.isFinite(stat.ino) ? stat.ino : null,
    }];
  }
  if (!stat.isDirectory()) return []; // 符号链接/设备文件：不进包，也不参与黑名单判定

  const files = [];
  await walkDir(absPath, '', files);
  return files;
}

/** 递归遍历（内部函数：relative 是相对"源根"的 POSIX 路径） */
async function walkDir(dirAbs, relativePrefix, out) {
  let dirents;
  try {
    dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return; // 读不到的子树跳过（由预检的 readable 字段/打包错误去暴露，不在遍历里抛）
  }
  for (const dirent of dirents) {
    const childAbs = path.join(dirAbs, dirent.name);
    const relative = relativePrefix ? `${relativePrefix}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      await walkDir(childAbs, relative, out);
      continue;
    }
    const entry = await fileEntryOf(childAbs, dirent, relative);
    if (entry) out.push(entry);
  }
}

/**
 * 单个非目录条目 → 待压文件记录（不是普通文件则返回 null）。
 * 抽出来是为了让 walkDir 只负责递归与分流（圈复杂度压在阈值内）。
 */
async function fileEntryOf(childAbs, dirent, relative) {
  if (!dirent.isFile()) return null; // 符号链接等一律不跟随、不进包
  // size 走 lstat（dirent 不带大小）：预检要按"被跳过文件的字节数"扣减待压量
  const fileStat = await fsp.lstat(childAbs).catch(() => null);
  if (!fileStat || !fileStat.isFile()) return null;
  return {
    absPath: childAbs,
    name: dirent.name,
    size: fileStat.size,
    // 同一份数据被多个路径指向（硬链接）时，这三个字段让上层能识别出"其实是同一份"
    dev: Number.isFinite(fileStat.dev) ? fileStat.dev : null,
    ino: Number.isFinite(fileStat.ino) ? fileStat.ino : null,
    relative,
    // 路径段用于"目录名规则"（如 @eaDir）：既包含中间目录，也包含文件名本身
    segments: relative.split('/'),
  };
}
