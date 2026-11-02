// 平台画像：系统判断 + 侧栏模式 + 显示文案 + 根发现策略的**唯一入口**
//
// 为什么单独抽一个文件：这三件事原本散在四处知识里 ——
//   ① roots.js 的两个枚举（PLATFORMS / SIDEBAR_MODES）
//   ② roots.js 的 detectPlatform()（群晖特征文件常量也在这里）
//   ③ roots.js 的 sidebarModeOf() 与 listRoots() 里的 if/else（决定根从哪来）
//   ④ 前端 Sidebar.vue 里写死的「模式 → 标题」映射
// 结果是「同一台机器该显示什么」由四处各自回答，加一个平台要改四个地方，必然漂移。
//
// 收敛后的规则：任何「这是什么系统 → 侧栏怎么显示 → 根从哪来」的判断，
// **只允许**由 resolvePlatformProfile() 回答；其余模块（含前端）只消费它的返回值。
//
// 分工（识别层 / 表现层）：
//   - **识别层**由 `sys-id` 提供（它判断"这是什么系统"，返回大写身份如 Synology / Linux）；
//   - **表现层**（身份 → 侧栏模式 / 标题 / 根发现策略）是本项目的资产，留在下面的画像表里。
// 换识别实现只动 detectPlatform 内部，画像表与所有调用方不变。

import fs from 'node:fs';

import { detectPlatform as detectSysIdPlatform } from 'sys-id';

/** 平台常量（将来接入独立探测包时，这张表由包的规则数据取代） */
export const PLATFORMS = Object.freeze({ SYNOLOGY: 'synology', WINDOWS: 'windows', POSIX: 'posix' });

/** 侧栏模式：B = 列卷（默认）；C = 列共享文件夹（群晖） */
export const SIDEBAR_MODES = Object.freeze({ VOLUMES: 'B', SHARES: 'C' });

/** 群晖特征文件（docs/16 §2.1 实测依据） */
const SYNOLOGY_MARKER = '/etc/synoinfo.conf'; // dsh-skip-sensitive

/** 系统目录前缀：@appdata / @eaDir / #recycle 等不是用户数据目录 */
const DEFAULT_SYSTEM_DIR_PREFIXES = Object.freeze(['@', '#']);

/**
 * 平台画像表：一个平台一行，决定它在界面上长什么样、根从哪来。
 *
 * 每个字段的用途：
 *   mode              侧栏模式（B = 卷 / C = 共享）
 *   volumeLabel       侧栏标题 —— 由后端下发，前端不再自己判断
 *   rootsStrategy     根发现策略：`shares` 扫共享 / `volumes` 扫卷与挂载点
 *   systemDirPrefixes 扫描时要排除的系统目录前缀
 *   volumePattern     卷目录名的匹配规则
 *
 * 加平台 = 在这张表加一行 + 在 PLATFORMS 加一个值（等独立包接入后，连这一步都省掉）。
 */
export const PLATFORM_PROFILE = Object.freeze({
  [PLATFORMS.SYNOLOGY]: Object.freeze({
    mode: SIDEBAR_MODES.SHARES,
    volumeLabel: '位置',
    rootsStrategy: 'shares',
    systemDirPrefixes: DEFAULT_SYSTEM_DIR_PREFIXES,
    volumePattern: /^\/volume\d+$/,
  }),
  [PLATFORMS.WINDOWS]: Object.freeze({
    mode: SIDEBAR_MODES.VOLUMES,
    volumeLabel: '存储卷',
    rootsStrategy: 'volumes',
    systemDirPrefixes: DEFAULT_SYSTEM_DIR_PREFIXES,
    volumePattern: /^\/volume\d+$/,
  }),
  [PLATFORMS.POSIX]: Object.freeze({
    mode: SIDEBAR_MODES.VOLUMES,
    volumeLabel: '存储卷',
    rootsStrategy: 'volumes',
    systemDirPrefixes: DEFAULT_SYSTEM_DIR_PREFIXES,
    volumePattern: /^\/volume\d+$/,
  }),
});

/** 未知平台一律回落 POSIX 画像：宁可显示成普通 Linux，也不能白屏 */
const FALLBACK_PROFILE = PLATFORM_PROFILE[PLATFORMS.POSIX];

/**
 * 本项目小写强制值 → sys-id 身份（大写）。
 * `posix` 落到 `Linux` 身份：本项目用它表示「非群晖、非 Windows」的通用表现。
 */
const FORCE_ENV_TO_IDENTITY = Object.freeze({
  [PLATFORMS.SYNOLOGY]: 'Synology',
  [PLATFORMS.WINDOWS]: 'Windows',
  [PLATFORMS.POSIX]: 'Linux',
});

/**
 * sys-id 身份 → 本项目枚举。
 * 只有群晖与 Windows 需要区别对待；其余身份（Linux/macOS/fnOS/Unknown/未来新增）都是 posix。
 */
const IDENTITY_TO_PLATFORM = Object.freeze({
  Synology: PLATFORMS.SYNOLOGY,
  Windows: PLATFORMS.WINDOWS,
});

/**
 * 平台探测：把识别工作交给 sys-id，本文件只维护「身份 → 本项目枚举」的映射。
 *
 * 三条与既有契约相关的处理（都不能省）：
 *   1. 身份大写、本项目枚举小写 —— 只有 Synology / Windows 有专属枚举，
 *      其余身份（Linux / macOS / fnOS / Unknown / 将来新增的平台）一律落到 posix，
 *      因为界面只需要区分「群晖（列共享）/ Windows / 其他（列卷）」三种表现；
 *   2. 强制值方向相反 —— 本项目环境变量是小写，sys-id 的 force 要大写身份，
 *      `posix` 对应 sys-id 的 `Linux` 身份；不在映射表里的值**不传 force**，走正常探测；
 *   3. sys-id 对非法 force 会抛错，而本项目既有契约是「非法强制值回落真实探测、不抛错」，
 *      所以必须 try/catch 兜住。
 *
 * 保留最后一层本地兜底：sys-id 自身异常（规则目录缺失等）时不能让整个页面挂掉。
 *
 * @param {{env?: object, existsSync?: (p: string) => boolean}} [options]
 */
export function detectPlatform({ env = process.env, existsSync = fs.existsSync } = {}) {
  const forced = env.ZIPCALM_FORCE_PLATFORM;
  const forcedIdentity = FORCE_ENV_TO_IDENTITY[forced];
  // sys-id 返回 { <身份>: {...} }，识别场景下只有一个键
  const identify = (force) => Object.keys(detectSysIdPlatform([], {
    env,
    existsSync,
    ...(force ? { force } : {}),
  }))[0];

  try {
    return IDENTITY_TO_PLATFORM[identify(forcedIdentity)] || PLATFORMS.POSIX;
  } catch {
    // 强制值不可用（sys-id 认为非法）或识别过程出错：**不抛错**，按无 force 重探一次
    try {
      return IDENTITY_TO_PLATFORM[identify(undefined)] || PLATFORMS.POSIX;
    } catch {
      return detectPlatformLocally(existsSync);
    }
  }
}

/** 最后兜底：sys-id 完全不可用时的最小识别（保证不抛错、不白屏） */
function detectPlatformLocally(existsSync) {
  try {
    if (existsSync(SYNOLOGY_MARKER)) return PLATFORMS.SYNOLOGY;
  } catch {
    // 探测失败按「不是群晖」处理
  }
  return process.platform === 'win32' ? PLATFORMS.WINDOWS : PLATFORMS.POSIX;
}

/**
 * 平台 → 侧栏模式。
 * 保留这个导出是为了不破坏既有调用方；**内部已改走画像表**，不再单独写一遍判断。
 */
export function sidebarModeOf(platform) {
  return (PLATFORM_PROFILE[platform] || FALLBACK_PROFILE).mode;
}

/**
 * **唯一入口**：一次给出「平台 + 该平台在界面上的一切表现」。
 *
 * 调用方拿到后不要再自己判断平台 —— 需要什么字段就用返回体里的：
 *   const { platform, mode, volumeLabel, rootsStrategy, systemDirPrefixes, volumePattern } = resolvePlatformProfile();
 *
 * @param {{env?: object, existsSync?: (p: string) => boolean}} [options]
 */
export function resolvePlatformProfile({ env = process.env, existsSync = fs.existsSync } = {}) {
  const platform = detectPlatform({ env, existsSync });
  const profile = PLATFORM_PROFILE[platform] || FALLBACK_PROFILE;
  return {
    platform,
    mode: profile.mode,
    volumeLabel: profile.volumeLabel,
    rootsStrategy: profile.rootsStrategy,
    systemDirPrefixes: profile.systemDirPrefixes,
    volumePattern: profile.volumePattern,
  };
}
