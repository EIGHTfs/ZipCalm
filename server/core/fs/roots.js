// 存储根发现（docs/16）：平台探测 → 侧栏模式 → 卷/共享列表
//
// 心智模型（docs/16 §一）：本项目的「根」不是文件系统 `/`，而是**可配置的存储根**。
// NAS 用户想的是"照片在哪个共享"，桌面用户想的是"先看卷"——所以两套数据源、同一个形状：
//   B 模式（非群晖）：卷 / 挂载点（/volume1、/mnt/data）
//   C 模式（群晖）：  /volumeN 下的共享文件夹（排除 @ / # 开头的系统目录）
//
// 所有失败都降级：扫不到就空列表、statfs 失败就容量 null —— 列卷失败绝不能让文件页打不开。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { ERROR_CODES, apiError } from '../../lib/errors.js';

/** 平台常量（将来加厂商在这里加一个值即可） */
export const PLATFORMS = Object.freeze({ SYNOLOGY: 'synology', WINDOWS: 'windows', POSIX: 'posix' });
/** 侧栏模式：B = 列卷（默认）；C = 列共享文件夹（群晖） */
export const SIDEBAR_MODES = Object.freeze({ VOLUMES: 'B', SHARES: 'C' });
/** 默认根在列表里的固定 id */
export const DEFAULT_ROOT_ID = 'default';

/** 群晖特征文件（docs/16 §2.1 实测依据） */
const SYNOLOGY_MARKER = '/etc/synoinfo.conf';
/** 群晖系统目录前缀：@appdata / @eaDir / #recycle 等不是共享 */
const SYSTEM_DIR_PREFIX = /^[@#]/;
/** B 模式的挂载点形态：/mnt/<name>、/media/<name>（只认一级，不认子目录） */
const MOUNT_POINT_ONE_LEVEL = /^\/(mnt|media)\/[^/]+$/;
/** 群晖卷名规则：/volume1 /volume2 ... */
const SYNOLOGY_VOLUME = /^\/volume\d+$/;

const statfsOf = (target) => fsp.statfs(target);
const readdirOf = (target) => fsp.readdir(target, { withFileTypes: true });

/**
 * 平台探测：环境变量覆盖优先（测试必需），其次群晖特征文件，最后按 Node platform 归类。
 * @param {{env?: object, existsSync?: (p: string) => boolean}} [options]
 */
export function detectPlatform({ env = process.env, existsSync = fs.existsSync } = {}) {
  const forced = env.ZIPCALM_FORCE_PLATFORM;
  if (forced === PLATFORMS.SYNOLOGY || forced === PLATFORMS.POSIX || forced === PLATFORMS.WINDOWS) return forced;
  try {
    if (existsSync(SYNOLOGY_MARKER)) return PLATFORMS.SYNOLOGY;
  } catch {
    // 探测失败按"不是群晖"处理：回退 B 模式，不能因为探测异常让整个页面挂掉
  }
  if (process.platform === 'win32') return PLATFORMS.WINDOWS;
  return PLATFORMS.POSIX;
}

/** 平台 → 侧栏模式（未知/将来厂商：默认 B，绝不白屏） */
export function sidebarModeOf(platform) {
  return platform === PLATFORMS.SYNOLOGY ? SIDEBAR_MODES.SHARES : SIDEBAR_MODES.VOLUMES;
}

/** 容量（statfs）；拿不到就两项都 null —— 契约要求降级不报错 */
export async function rootStats(absPath) {
  try {
    const stat = await statfsOf(absPath);
    const blockSize = Number(stat.bsize) || 0;
    const totalBytes = blockSize * (Number(stat.blocks) || 0);
    const freeBytes = blockSize * (Number(stat.bavail ?? stat.bfree) || 0);
    if (!(totalBytes > 0)) return { totalBytes: null, freeBytes: null };
    return { totalBytes, freeBytes };
  } catch {
    return { totalBytes: null, freeBytes: null };
  }
}

/** 目录里的子目录名（失败返回 []） */
async function listSubdirs(dirAbs) {
  try {
    const dirents = await readdirOf(dirAbs);
    return dirents.filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name);
  } catch {
    return [];
  }
}

/** 读 /proc/mounts 的挂载点（Linux）；失败返回 [] */
async function readMountPoints() {
  try {
    const text = await fsp.readFile('/proc/mounts', 'utf8');
    return text.split('\n')
      .map((line) => line.split(/\s+/))
      .filter((fields) => fields.length >= 2)
      .map((fields) => fields[1].replace(/\\040/g, ' '));
  } catch {
    return [];
  }
}

/**
 * B 模式：自动发现卷/挂载点。
 * 规则：/volumeN + /proc/mounts 里的 /mnt|/media 挂载点（去重，按路径排序）。
 * 为什么不全用 /proc/mounts：容器里它会列出一堆伪文件系统（proc/sysfs/tmpfs），对用户无意义。
 */
async function discoverVolumeDirs() {
  const found = new Set();
  for (const dirName of await listSubdirs('/')) {
    if (/^volume\d+$/.test(dirName)) found.add(`/${dirName}`);
  }
  // 只认"真正挂载了的"一级目录：/mnt/data、/media/usb 这种。
  // 不能拿 /mnt/* 的**子目录**当卷 —— 很多机器 /mnt 本身就是一个挂载点，里面全是普通目录（实测踩过）。
  for (const mountPoint of await readMountPoints()) {
    if (MOUNT_POINT_ONE_LEVEL.test(mountPoint)) found.add(mountPoint);
    if (SYNOLOGY_VOLUME.test(mountPoint)) found.add(mountPoint);
  }
  return [...found].sort();
}

/** C 模式：/volumeN 下的共享文件夹（排除 @ / # 系统目录） */
async function discoverShares() {
  const volumes = [];
  for (const dirName of await listSubdirs('/')) {
    if (/^volume\d+$/.test(dirName)) volumes.push(`/${dirName}`);
  }
  const shares = [];
  for (const volumeAbs of volumes.sort()) {
    for (const name of await listSubdirs(volumeAbs)) {
      if (SYSTEM_DIR_PREFIX.test(name)) continue;
      shares.push({ id: name, label: name, path: path.posix.join(volumeAbs, name) });
    }
  }
  return shares;
}

/**
 * 构造根列表。
 * - 配置了 storage.roots → 直接用（两种模式都用它；显式配置优先于自动发现）
 * - C 模式且没配置 → 扫共享；扫不到任何共享 → 回退列出默认根（避免侧栏空白）
 * - B 模式且没配置 → 扫卷；扫不到 → 只列默认根
 * - ZIPCALM_SHOW_APP_ROOT=1 → 任何模式都额外列出默认根（标注「应用数据」）
 * @param {{storage: object, env?: object}} options
 */
export async function listRoots({ storage, env = process.env }) {
  const platform = detectPlatform({ env });
  const mode = sidebarModeOf(platform);
  const configured = Array.isArray(storage.roots) && storage.roots.length > 0
    ? storage.roots.map((root) => ({ id: root.id, label: root.label || root.id, path: root.path }))
    : null;
  const defaultRoot = { id: DEFAULT_ROOT_ID, label: '应用数据', path: storage.root };

  let roots;
  if (configured) {
    roots = configured;
  } else if (mode === SIDEBAR_MODES.SHARES) {
    const shares = await discoverShares();
    roots = shares.length > 0 ? shares : [defaultRoot];
  } else {
    const volumes = await discoverVolumeDirs();
    roots = volumes.length > 0
      ? volumes.map((volumePath) => ({ id: volumePath.replace(/^\/+/, ''), label: path.basename(volumePath), path: volumePath }))
      : [defaultRoot];
  }

  // 环境变量开关：把应用存储根也列进来（默认关；群晖上开发/验收时很有用）
  if (env.ZIPCALM_SHOW_APP_ROOT === '1' && !roots.some((root) => path.resolve(root.path) === path.resolve(defaultRoot.path))) {
    roots = [...roots, { ...defaultRoot, label: '应用数据（storage.root）' }];
  }

  const withStats = await Promise.all(roots.map(async (root) => ({ ...root, ...(await rootStats(root.path)) })));
  return { platform, mode, roots: withStats, canSwitch: withStats.length > 1 };
}

/**
 * 按 rootId 取根（幂等；未知 id → VALIDATION_FAILED，绝不静默回落默认根 —— 静默回落会让用户以为切了根）。
 * @param {{roots: Array<{id: string, path: string}>, rootAbs: string}} fsContext
 * @param {string|undefined} rootId
 * @returns {{id: string, absPath: string}}
 */
export function resolveRoot(fsContext, rootId) {
  // 未指定或就是 default：用配置里的 storage.root。
  // 注意 default **不一定出现在 /fs/volumes 的列表里**（C 模式默认只列共享），但请求必须能用它 ——
  // 否则"不带 rootId 的请求能工作、带 rootId=default 反而 400"，自相矛盾。
  if (!rootId || rootId === DEFAULT_ROOT_ID) return { id: DEFAULT_ROOT_ID, absPath: fsContext.rootAbs };
  const matched = (fsContext.roots || []).find((root) => root.id === rootId);
  if (!matched) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, `未知的 rootId：${rootId}`, { rootId });
  }
  return { id: matched.id, absPath: matched.path };
}
