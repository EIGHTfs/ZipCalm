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

import fs from 'node:fs';

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
 * 平台探测：环境变量覆盖优先（测试必需），其次群晖特征文件，最后按 Node platform 归类。
 *
 * 非法强制值（如 `ZIPCALM_FORCE_PLATFORM=nonsense`）**回落真实探测而非抛错** ——
 * 这是验收脚本明确断言的既有行为，换环境变量写法时不能顺手改成抛错。
 *
 * @param {{env?: object, existsSync?: (p: string) => boolean}} [options]
 */
export function detectPlatform({ env = process.env, existsSync = fs.existsSync } = {}) {
  const forced = env.ZIPCALM_FORCE_PLATFORM;
  if (Object.values(PLATFORMS).includes(forced)) return forced;
  try {
    if (existsSync(SYNOLOGY_MARKER)) return PLATFORMS.SYNOLOGY;
  } catch {
    // 探测失败按「不是群晖」处理：回退 B 模式，不能因为探测异常让整个页面挂掉
  }
  if (process.platform === 'win32') return PLATFORMS.WINDOWS;
  return PLATFORMS.POSIX;
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
