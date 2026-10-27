// 硬链接统计（预检用）：把"哪些文件其实是同一份数据"算清楚
//
// 判定依据只有一条：**同 dev 且同 ino** 才是硬链接。只比 ino 是错的——不同文件系统上
// 出现相同的 ino 完全可能（跨分区/跨设备），把它们当成硬链接会给出错误的空间提示。
//
// 为什么单独成模块：这段逻辑是纯计算（不碰文件系统），单独放便于直接单测跨设备场景；
// 预检只负责"遍历时喂数据 + 用结果拼响应"。

/**
 * 累加器：`seen` 按 absPath 去重（用户可能同时选了一个目录和它里面的文件），
 * `groups` 按 `dev:ino` 归组。
 */
export function createHardlinkAccumulator() {
  return { seen: new Set(), groups: new Map() };
}

/**
 * 记录一个文件。dev/ino 缺失（极少数文件系统不给）时无法判定，直接忽略。
 * @param {{seen: Set<string>, groups: Map<string, {count: number, size: number}>}} accumulator
 * @param {{absPath: string, dev: number, ino: number, size: number}} file
 */
export function accumulateHardlink(accumulator, file) {
  if (!file || typeof file.absPath !== 'string') return;
  if (accumulator.seen.has(file.absPath)) return;
  accumulator.seen.add(file.absPath);
  if (!Number.isFinite(file.dev) || !Number.isFinite(file.ino)) return;
  const key = `${file.dev}:${file.ino}`;
  const existing = accumulator.groups.get(key);
  if (existing) {
    existing.count += 1;
    return;
  }
  accumulator.groups.set(key, { count: 1, size: Number(file.size) || 0 });
}

/**
 * 把一个不会进包的文件（如命中黑名单被跳过）从统计里扣掉。
 * 不扣的话会出现"两个成员都被跳过，却提示 ZIP 会存两份"的错误提示。
 */
export function discardHardlink(accumulator, file) {
  if (!file || typeof file.absPath !== 'string') return;
  if (!accumulator.seen.delete(file.absPath)) return;
  if (!Number.isFinite(file.dev) || !Number.isFinite(file.ino)) return;
  const key = `${file.dev}:${file.ino}`;
  const group = accumulator.groups.get(key);
  if (!group) return;
  group.count -= 1;
  if (group.count <= 0) accumulator.groups.delete(key);
}

/**
 * 汇总：组数 / 组内文件数 / "多存"的字节。
 * 同组各路径指向同一份数据、size 相同，所以 (count-1) 份就是多出来的量。
 * @returns {{groups: number, files: number, duplicatedBytes: number}}
 */
export function finalizeHardlinks(accumulator) {
  let groups = 0;
  let files = 0;
  let duplicatedBytes = 0;
  for (const group of accumulator.groups.values()) {
    if (group.count < 2) continue;
    groups += 1;
    files += group.count;
    duplicatedBytes += (group.count - 1) * group.size;
  }
  return { groups, files, duplicatedBytes };
}
