// /proc 解析（Linux 专用；读不到一律返回 null，**绝不抛**）
//
// 为什么用 /proc 而不是引 systeminformation：
//   契约（docs/M0/API规范.md §4.6）要的字段全部可由 Node 内置 + /proc 得到；
//   systeminformation 多出来的（温度/风扇/网络/进程列表）恰是 docs/07 §四 明确不做的，
//   而且它不少方法靠 spawn 系统命令实现 —— 一个"开销必须 <1%"的监控不该在底层 spawn 进程。
//
// 降级策略：容器/非 Linux 环境下 /proc 文件可能不存在或格式不同 → 每个解析函数都返回 null，
// 由上层把对应字段填 null（接口仍然活着，前端显示"—"），**不允许 500**。

import fsp from 'node:fs/promises';

const SECTOR_BYTES = 512;

/**
 * 只统计物理盘（sd* / nvme*），**刻意排除** md* / dm-* / loop*：
 * 同一份物理 IO 会在 md（软 RAID 成员）与 dm（LVM/加密）上被重复上报，
 * 全都加进来就是双倍甚至三倍的虚高。NAS 上这个差别非常明显。
 */
const PHYSICAL_DISK = /^(sd[a-z]+|nvme\d+n\d+)$/;

/** 读文件；不存在/无权限返回 null（不抛） */
async function readProc(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 系统 CPU 累计时间（jiffies）。解析 /proc/stat 首行 `cpu user nice system idle iowait irq softirq steal`。
 * @returns {{idle: number, total: number} | null}
 */
export function parseProcStat(text) {
  if (typeof text !== 'string') return null;
  const line = text.split('\n').find((row) => row.startsWith('cpu '));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map((value) => Number.parseInt(value, 10));
  if (values.length < 4 || values.some((value) => !Number.isFinite(value))) return null;
  // idle + iowait 都算"空转"（iowait 时 CPU 没在干活，对"卡不卡"的观感与 idle 一致）
  const idle = (values[3] || 0) + (values[4] || 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  return { idle, total };
}

/**
 * 内存（字节）。用 MemAvailable 而不是 MemFree：
 * NAS 上页缓存会吃掉大量内存，MemFree 常年很低 → 会显示"内存快满了"的假警报；
 * MemAvailable 才是内核估计的"还能给新程序用多少"。
 * @returns {{usedBytes: number, totalBytes: number} | null}
 */
export function parseMemInfo(text) {
  if (typeof text !== 'string') return null;
  const readKb = (key) => {
    const match = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
    return match ? Number.parseInt(match[1], 10) * 1024 : null;
  };
  const total = readKb('MemTotal');
  const available = readKb('MemAvailable');
  if (!Number.isFinite(total) || !Number.isFinite(available)) return null;
  return { usedBytes: Math.max(0, total - available), totalBytes: total };
}

/**
 * 磁盘累计扇区数（只汇总物理盘）。字段顺序见 proc(5) diskstats：
 * `major minor name reads readsMerged sectorsRead msRead writes writesMerged sectorsWritten ...`
 * @returns {{readSectors: number, writeSectors: number} | null}
 */
export function parseDiskStats(text) {
  if (typeof text !== 'string') return null;
  let readSectors = 0;
  let writeSectors = 0;
  let matched = 0;
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const device = fields[2];
    if (!PHYSICAL_DISK.test(device)) continue;
    const sectorsRead = Number.parseInt(fields[5], 10);
    const sectorsWritten = Number.parseInt(fields[9], 10);
    if (!Number.isFinite(sectorsRead) || !Number.isFinite(sectorsWritten)) continue;
    readSectors += sectorsRead;
    writeSectors += sectorsWritten;
    matched += 1;
  }
  return matched > 0 ? { readSectors, writeSectors } : null;
}

/** 读一次全量原始值（三个来源各自独立降级） */
export async function readProcSnapshot() {
  const [statText, memText, diskText] = await Promise.all([
    readProc('/proc/stat'),
    readProc('/proc/meminfo'),
    readProc('/proc/diskstats'),
  ]);
  return {
    cpuTimes: parseProcStat(statText),
    memory: parseMemInfo(memText),
    disk: parseDiskStats(diskText),
  };
}

/** 扇区数 → 字节（供采集器算 Bps） */
export function sectorsToBytes(sectors) {
  return Number(sectors) * SECTOR_BYTES;
}
