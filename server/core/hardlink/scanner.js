// 硬链接去重 · 扫描器（docs/15 §三：size 分组 → 抽样快筛 → 全量哈希终判）
//
// 评审教训（docs/15 §二.①，本模块的实现红线）：
//   **抽样哈希不能判定重复**——同系列视频（S01E01/S01E02）容器头一致、索引尾也常一致，
//   中间内容完全不同。抽样若被当终判，合并后其中一集内容永久消失。
//   所以抽样只做「快速筛」（排除明显不同的，减少全量哈希的量），**终判必须全量 SHA-256**。
//
// 跳过规则（docs/15 §三.扫描）：
//   - 符号链接（lstat 不跟随）
//   - 已有硬链接的文件（nlink > 1：已是链接副本，再链无收益且语义混乱）
//   - 跨文件系统条目（dev 与扫描根不同：硬链接的硬限制，链不起来）
//   - 非白名单扩展名
//
// 结果：只报告组内 ≥ 2 的分组；每组带 master（组内第一个）与 duplicates；dry-run 不动任何文件。

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 抽样快筛的段配置：头 / 尾各 4KB + 中间随机 2 段（docs/15 §二.① 正确做法 2） */
const SAMPLE_CHUNK = 4096;
const SAMPLE_MID_SEGMENTS = 2;

/** 全量哈希的块大小（流式读，4MB 平衡内存与 syscalls） */
const HASH_CHUNK = 4 * 1024 * 1024;

/** 判断扩展名是否在白名单（大小写不敏感；extensions 形如 ['mp4','mkv'] 不带点） */
export function isAllowedExtension(fileName, extensions) {
  const ext = path.extname(fileName).replace(/^\./, '').toLowerCase();
  return extensions.includes(ext);
}

/** 递归遍历（自写不复用 sourceWalk：这里要带 dev/nlink 跳过规则与扩展名过滤） */
export async function walkCandidates(rootAbs, extensions, options = {}) {
  const { onProgress } = options;
  const rootStat = await fsp.stat(rootAbs); // stat：扫描根自身允许是链接后的目录
  const candidates = [];
  let scanned = 0;

  const walk = async (dirAbs) => {
    let dirents;
    try {
      dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return; // 读不到的子树跳过（权限），与项目其他遍历的容错口径一致
    }
    for (const dirent of dirents) {
      const childAbs = path.join(dirAbs, dirent.name);
      // 只用 lstat 信息判断目录（不跟随链接目录，防环）；isSymbolicLink 一律跳过
      if (dirent.isDirectory()) {
        await walk(childAbs);
        continue;
      }
      if (!dirent.isFile()) continue; // symlink / 设备 / fifo：不进候选
      if (!isAllowedExtension(dirent.name, extensions)) continue;
      const stat = await fsp.lstat(childAbs).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      // 已有硬链接的文件跳过（nlink > 1：已经是某个"去重"的产物或副本）
      if (stat.nlink > 1) continue;
      // 跨文件系统跳过（dev 不同：link() 会 EXDEV，链不起来）
      if (stat.dev !== rootStat.dev) continue;
      scanned += 1; // 语义 = 通过全部跳过规则、进入候选清单的数量（过滤前计数会虚高，实测踩过）
      candidates.push({ absPath: childAbs, size: stat.size, dev: stat.dev, ino: stat.ino });
      if (onProgress && scanned % 100 === 0) onProgress({ scanned, currentFile: childAbs });
    }
  };

  await walk(rootAbs);
  return { candidates, scanned, rootDev: rootStat.dev };
}

/** 按 size 分组，只留 ≥2 的组（零成本先砍掉绝大部分候选） */
export function groupBySize(candidates) {
  const bySize = new Map();
  for (const candidate of candidates) {
    if (!bySize.has(candidate.size)) bySize.set(candidate.size, []);
    bySize.get(candidate.size).push(candidate);
  }
  return [...bySize.entries()]
    .filter(([, group]) => group.length >= 2)
    .map(([size, group]) => ({ size, group }));
}

/**
 * 流式读取文件的抽样段：头 4KB + 尾 4KB + 中间随机 2 段（各 4KB）。
 * 返回这些段的 sha256 串联指纹——**仅用于快速筛**，不是重复判定。
 */
async function sampleFingerprint(absPath, size) {
  const hash = crypto.createHash('sha256');
  const handle = await fsp.open(absPath, 'r');
  try {
    const read = async (position) => {
      const buffer = Buffer.alloc(SAMPLE_CHUNK);
      const { bytesRead } = await handle.read(buffer, 0, SAMPLE_CHUNK, position);
      hash.update(buffer.subarray(0, bytesRead));
    };
    await read(0);
    if (size > SAMPLE_CHUNK) await read(size - SAMPLE_CHUNK);
    if (size > SAMPLE_CHUNK * 3) {
      // 中间随机段：以文件内容无关的 task 级随机偏移取 2 段（伪随机可复现性不需要，防"恰好都取到相同结构区"）
      for (let i = 0; i < SAMPLE_MID_SEGMENTS; i += 1) {
        const pos = SAMPLE_CHUNK + Math.floor(Math.random() * (size - SAMPLE_CHUNK * 3)) + i * 1024;
        await read(Math.min(pos, size - SAMPLE_CHUNK));
      }
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

/** 全量 SHA-256（终判）：流式读，4MB 块 */
export async function fullHash(absPath) {
  const hash = crypto.createHash('sha256');
  const handle = await fsp.open(absPath, 'r');
  try {
    const buffer = Buffer.alloc(HASH_CHUNK);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, HASH_CHUNK, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

/**
 * 扫描主流程：walk → size 分组 → 抽样快筛 → 全量哈希终判。
 *
 * @param {string} rootAbs 扫描根（绝对路径，调用方已过白名单）
 * @param {string[]} extensions 白名单扩展名（不带点）
 * @param {object} [options] { onProgress({stage, scanned, hashed, total}) }
 * @returns {Promise<{groups: Array<{size, hash, master, duplicates, savedBytes}>, stats: {...}}>}
 */
export async function scanHardlinkDuplicates(rootAbs, extensions, options = {}) {
  const { onProgress } = options;
  const { candidates, scanned, rootDev } = await walkCandidates(rootAbs, extensions, { onProgress });

  const groups = [];
  let hashed = 0;
  let skippedBySample = 0;

  for (const { size, group } of groupBySize(candidates)) {
    // 抽样快筛：指纹相同的才进全量哈希（不同 → 直接排除，省全量读）
    const fingerprints = new Map();
    for (const candidate of group) {
      const fp = await sampleFingerprint(candidate.absPath, size);
      if (!fingerprints.has(fp)) fingerprints.set(fp, []);
      fingerprints.get(fp).push(candidate);
      hashed += 1;
    }
    for (const fpGroup of fingerprints.values()) {
      if (fpGroup.length < 2) {
        skippedBySample += fpGroup.length;
        continue;
      }
      // 全量哈希终判（评审红线：抽样不能判重复）
      const hashes = new Map();
      for (const candidate of fpGroup) {
        const digest = await fullHash(candidate.absPath);
        if (!hashes.has(digest)) hashes.set(digest, []);
        hashes.get(digest).push(candidate);
      }
      for (const [digest, digestGroup] of hashes.entries()) {
        if (digestGroup.length < 2) continue; // 抽样同但全量不同：终判正确排除（伪造重复守门人覆盖此路径）
        const [master, ...duplicates] = digestGroup;
        groups.push({
          size,
          hash: digest,
          master: master.absPath,
          duplicates: duplicates.map((d) => d.absPath),
          savedBytes: size * duplicates.length,
        });
      }
    }
    if (onProgress) onProgress({ stage: 'group-done', scanned, hashed });
  }

  return {
    groups,
    stats: { scanned, hashed, skippedBySample, rootDev, groupCount: groups.length, savedBytes: groups.reduce((sum, g) => sum + g.savedBytes, 0) },
  };
}
