#!/usr/bin/env node
//
// 硬链接预检提示验收（docs/18 §③）
//
// 分两层：
//   1) 纯函数层（hardlinkScan）：分组键、跨设备不误判、去重、黑名单回退扣减 —— 不需要服务
//   2) API 层（/compress/preflight）：实际目录上 zip 提示 / tar 正向 / 无硬链接不提示 / 阈值
//
// 为什么夹具必须放本地卷：工作区是 CIFS(SMB)，`ln` 在 SMB 上退化成"复制"（inode 不同），
// 造不出真硬链接。所以夹具建在共享根（本地 btrfs）下，走 rootId=VirtualDSM。
//
// 用法：bash scripts/start.sh start && node scripts/test-hardlink-hint.mjs

import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  accumulateHardlink,
  createHardlinkAccumulator,
  discardHardlink,
  finalizeHardlinks,
} from '../server/core/compress/hardlinkScan.js';
import { HARDLINK_HINT_MIN_RATIO, formatPreservesHardlinks, shouldHintHardlink } from '../shared/hardlink-hint.js';
import { loadRuntimeConfig } from './helpers/test-config.mjs';
import { PROJECT_ROOT } from './helpers/script-env.mjs';
import { createReporter } from './helpers/test-report.mjs';

const runtimeConfig = await loadRuntimeConfig(PROJECT_ROOT);
const PORT = process.env.ZIPCALM_PORT || (runtimeConfig.server && runtimeConfig.server.port) || 3010;
const BASE = process.env.ZIPCALM_BASE || `http://127.0.0.1:${PORT}/api/v1`;
const LOGIN = { username: process.env.ZIPCALM_TEST_USER || 'admin', password: process.env.ZIPCALM_TEST_PASSWORD || 'zipcalm' };
const HTTP_TIMEOUT_MS = 20000;

// 硬链接夹具必须落在**支持硬链接**的文件系统上：CIFS/SMB 上 `ln` 会退化成"复制"（inode 不同），
// 造不出真硬链接。这里不写死路径 —— 从 /fs/volumes 取候选位置，逐个实建一个临时硬链接试出来。
const FIXTURE_PREFIX = `zipcalm-hl-hint-${process.pid}`;
let FIXTURE_DIR = null;   // 由 pickHardlinkCapableRoot() 决定
let FIXTURE_NAME = null;
let ROOT_ID = null;
let probeDir = null;

const reporter = createReporter();
const { check } = reporter;
let TOKEN = null;

const KB = 1024;
// 夹具尺寸（KB）：配对文件要大、普通文件要小/大各有讲究，见各段注释
const PAIR_FILE_KB = 256;   // 主硬链接对：重复量明显（占比 ≈45%）
const SMALL_FILE_KB = 64;   // 陪衬文件：让逻辑大小不至于等于重复量
const TINY_PAIR_KB = 32;    // 小硬链接对：制造"低于阈值"的对照组
const BIG_FILE_KB = 1024;   // 大普通文件：把重复占比压到 3% 左右
const PLAIN_FILE_KB = 16;   // 无硬链接对照目录里的普通文件

async function preflight(payload) {
  const response = await fetch(`${BASE}/compress/preflight`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify({ rootId: ROOT_ID, mode: 'bundle', ...payload }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const json = await response.json();
  return { status: response.status, json, data: (json && json.data) || null };
}

/**
 * 在指定目录下真的建一个硬链接，验证该文件系统支持硬链接。
 * 抽成独立函数：把写操作移出候选循环（读起来也更清楚——"试一次"就是一次完整尝试）。
 * @param {string} dirAbs
 * @returns {Promise<boolean>}
 */
async function probeHardlinkAt(dirAbs) {
  try {
    await fsp.mkdir(dirAbs, { recursive: true });
    const probeFile = path.join(dirAbs, 'probe.bin');
    await fsp.writeFile(probeFile, 'probe');
    await fsp.link(probeFile, path.join(dirAbs, 'probe-link.bin'));
    return true;
  } catch {
    await fsp.rm(dirAbs, { recursive: true, force: true }).catch(() => {});
    return false;
  }
}

/**
 * 找一个"能建硬链接"的存储位置：从 /fs/volumes 拿候选，逐个试建临时硬链接。
 * 全部失败返回 null（调用方 skip，不误报失败）——例如所有位置都挂在 CIFS/SMB 上时。
 */
async function pickHardlinkCapableRoot() {
  const response = await fetch(`${BASE}/fs/volumes`, {
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const json = await response.json().catch(() => null);
  const roots = (json && json.data && json.data.roots) || [];
  for (const root of roots) {
    if (!root || typeof root.path !== 'string' || !root.id) continue;
    const candidate = path.join(root.path, `${FIXTURE_PREFIX}-probe`);
    if (!(await probeHardlinkAt(candidate))) continue;
    return { rootId: root.id, shareRoot: root.path, probeDir: candidate };
  }
  return null;
}

/** 纯函数层：分组键必须是 dev+ino（跨设备相同 ino 不算硬链接） */
function assertUnitLayer() {
  const sameDevice = createHardlinkAccumulator();
  accumulateHardlink(sameDevice, { absPath: '/a', dev: 1, ino: 100, size: 2048 });
  accumulateHardlink(sameDevice, { absPath: '/b', dev: 1, ino: 100, size: 2048 });
  const grouped = finalizeHardlinks(sameDevice);
  check('同 dev 同 ino → 识别为 1 组 2 个文件',
    grouped.groups === 1 && grouped.files === 2 && grouped.duplicatedBytes === 2048, JSON.stringify(grouped));

  const crossDevice = createHardlinkAccumulator();
  accumulateHardlink(crossDevice, { absPath: '/a', dev: 1, ino: 100, size: 2048 });
  accumulateHardlink(crossDevice, { absPath: '/b', dev: 2, ino: 100, size: 2048 });
  const cross = finalizeHardlinks(crossDevice);
  check('同 ino 不同 dev（跨分区）→ 不算硬链接', cross.groups === 0 && cross.duplicatedBytes === 0, JSON.stringify(cross));

  const duplicatedPath = createHardlinkAccumulator();
  accumulateHardlink(duplicatedPath, { absPath: '/a', dev: 1, ino: 100, size: 2048 });
  accumulateHardlink(duplicatedPath, { absPath: '/a', dev: 1, ino: 100, size: 2048 });
  check('同一 absPath 重复喂入只算一次（嵌套选择的去重）', finalizeHardlinks(duplicatedPath).groups === 0,
    JSON.stringify(finalizeHardlinks(duplicatedPath)));

  const withDiscard = createHardlinkAccumulator();
  accumulateHardlink(withDiscard, { absPath: '/a', dev: 1, ino: 100, size: 2048 });
  accumulateHardlink(withDiscard, { absPath: '/b', dev: 1, ino: 100, size: 2048 });
  discardHardlink(withDiscard, { absPath: '/b', dev: 1, ino: 100, size: 2048 });
  check('跳过项被扣减后不再成组（黑名单全跳过时不该提示）', finalizeHardlinks(withDiscard).groups === 0,
    JSON.stringify(finalizeHardlinks(withDiscard)));

  check('阈值：10% 边界（低于不提示、达到才提示）',
    shouldHintHardlink({ logicalBytes: 1000, duplicatedBytes: 99 }) === false
    && shouldHintHardlink({ logicalBytes: 1000, duplicatedBytes: 100 }) === true,
    `阈值=${HARDLINK_HINT_MIN_RATIO}`);

  check('格式判定：tar 家族保留硬链接、zip 不保留、未知格式按不保留处理',
    formatPreservesHardlinks('tar') && formatPreservesHardlinks('targz') && formatPreservesHardlinks('tarzst')
    && !formatPreservesHardlinks('zip') && !formatPreservesHardlinks('unknown-fmt'),
    'tar/targz/tarzst=true, zip=false');
}

async function main() {
  assertUnitLayer();

  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(LOGIN),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  }).then((response) => response.json());
  TOKEN = login && login.data && login.data.token;
  check('登录拿到 Bearer Token', Boolean(TOKEN));
  if (!TOKEN) return;

  // ===== 选定夹具位置（必须支持硬链接；探测不到就 skip，不误报失败）=====
  const capable = await pickHardlinkCapableRoot();
  if (!capable) {
    reporter.skip('API 层硬链接断言', '所有存储位置都不支持硬链接（可能都挂在 CIFS/SMB 上），无法构造夹具');
    return;
  }
  ROOT_ID = capable.rootId;
  probeDir = capable.probeDir;
  FIXTURE_DIR = path.join(capable.shareRoot, FIXTURE_PREFIX);
  FIXTURE_NAME = `/${FIXTURE_PREFIX}`;

  const hlDir = path.join(FIXTURE_DIR, 'hardlinked');
  const tinyDir = path.join(FIXTURE_DIR, 'tiny-duplicate');
  const plainDir = path.join(FIXTURE_DIR, 'plain');
  await fsp.mkdir(hlDir, { recursive: true });
  await fsp.mkdir(tinyDir, { recursive: true });
  await fsp.mkdir(plainDir, { recursive: true });

  try {
    // 1) 明显的硬链接：两份 256KB 互为硬链接 + 一份 64KB 普通文件（重复占比 ≈45%）
    await fsp.writeFile(path.join(hlDir, 'a.bin'), Buffer.alloc(PAIR_FILE_KB * KB, 1));
    await fsp.link(path.join(hlDir, 'a.bin'), path.join(hlDir, 'b.bin'));
    await fsp.writeFile(path.join(hlDir, 'c.bin'), Buffer.alloc(SMALL_FILE_KB * KB, 2));

    // 2) 重复量极小的硬链接：32KB 一对 + 1MB 普通文件（重复占比 ≈3%，低于阈值不该提示）
    await fsp.writeFile(path.join(tinyDir, 'small.bin'), Buffer.alloc(TINY_PAIR_KB * KB, 3));
    await fsp.link(path.join(tinyDir, 'small.bin'), path.join(tinyDir, 'small-link.bin'));
    await fsp.writeFile(path.join(tinyDir, 'big.bin'), Buffer.alloc(BIG_FILE_KB * KB, 4));

    // 3) 无硬链接对照
    await fsp.writeFile(path.join(plainDir, 'x.bin'), Buffer.alloc(PLAIN_FILE_KB * KB, 5));
    await fsp.writeFile(path.join(plainDir, 'y.bin'), Buffer.alloc(PLAIN_FILE_KB * KB, 6));

    const zipOnHl = await preflight({ sources: [`${FIXTURE_NAME}/hardlinked`], format: 'zip' });
    const hl = (zipOnHl.data && zipOnHl.data.hardlinks) || null;
    check('zip 预检：识别 1 组硬链接 2 个文件', Boolean(hl) && hl.groups === 1 && hl.files === 2,
      `groups=${hl && hl.groups} files=${hl && hl.files}`);
    check('zip 预检：多存字节 = 一份重复文件大小（256KB）', Boolean(hl) && hl.duplicateBytes === PAIR_FILE_KB * KB, `duplicateBytes=${hl && hl.duplicateBytes}`);
    check('zip 预检：hint=true（重复占比高于阈值）', Boolean(hl) && hl.hint === true && hl.preservedByFormat === false,
      `hint=${hl && hl.hint} preserved=${hl && hl.preservedByFormat}`);
    check('zip 预检：估算产出 = 逻辑大小（各存一份）', Boolean(hl) && hl.estimatedBytes === hl.logicalBytes, `est=${hl && hl.estimatedBytes} logical=${hl && hl.logicalBytes}`);

    const tarOnHl = await preflight({ sources: [`${FIXTURE_NAME}/hardlinked`], format: 'tar' });
    const tarHl = (tarOnHl.data && tarOnHl.data.hardlinks) || null;
    check('tar 预检：preservedByFormat=true 且 hint=false（改成正向说明）',
      Boolean(tarHl) && tarHl.preservedByFormat === true && tarHl.hint === false,
      `preserved=${tarHl && tarHl.preservedByFormat} hint=${tarHl && tarHl.hint}`);
    check('tar 预检：估算产出 = 逻辑大小 − 重复份（只存一份）',
      Boolean(tarHl) && tarHl.estimatedBytes === tarHl.logicalBytes - PAIR_FILE_KB * KB,
      `est=${tarHl && tarHl.estimatedBytes} logical=${tarHl && tarHl.logicalBytes}`);

    const targzOnHl = await preflight({ sources: [`${FIXTURE_NAME}/hardlinked`], format: 'targz' });
    check('targz 也按"保留硬链接"处理（tar 家族）',
      Boolean(targzOnHl.data && targzOnHl.data.hardlinks && targzOnHl.data.hardlinks.preservedByFormat === true),
      `preserved=${Boolean(targzOnHl.data && targzOnHl.data.hardlinks && targzOnHl.data.hardlinks.preservedByFormat)}`);

    const plainZip = await preflight({ sources: [`${FIXTURE_NAME}/plain`], format: 'zip' });
    const plainHl = (plainZip.data && plainZip.data.hardlinks) || null;
    check('无硬链接目录：groups=0 且 hint=false（不打扰普通用户）',
      Boolean(plainHl) && plainHl.groups === 0 && plainHl.hint === false, JSON.stringify(plainHl));

    const tinyZip = await preflight({ sources: [`${FIXTURE_NAME}/tiny-duplicate`], format: 'zip' });
    const tinyHl = (tinyZip.data && tinyZip.data.hardlinks) || null;
    check('重复占比低于阈值：识别出组但不提示（避免噪声）',
      Boolean(tinyHl) && tinyHl.groups === 1 && tinyHl.hint === false, JSON.stringify(tinyHl));

    const singleFile = await preflight({ sources: [`${FIXTURE_NAME}/hardlinked/a.bin`], format: 'zip' });
    const singleHl = (singleFile.data && singleFile.data.hardlinks) || null;
    check('只选硬链接中的一个文件：groups=0（包里只有一份，无需提示）',
      Boolean(singleHl) && singleHl.groups === 0, JSON.stringify(singleHl));

    const nested = await preflight({ sources: [`${FIXTURE_NAME}/hardlinked`, `${FIXTURE_NAME}/hardlinked/a.bin`], format: 'zip' });
    const nestedHl = (nested.data && nested.data.hardlinks) || null;
    check('嵌套选择（目录 + 其中文件）不重复计数：仍为 1 组 2 个文件',
      Boolean(nestedHl) && nestedHl.groups === 1 && nestedHl.files === 2, JSON.stringify(nestedHl));
  } finally {
    // 夹具自清（只删自己建的目录；回收站不涉及）
    await fsp.rm(FIXTURE_DIR, { recursive: true, force: true }).catch(() => {});
    if (probeDir) await fsp.rm(probeDir, { recursive: true, force: true }).catch(() => {});
  }
}

main()
  .then(() => {
    const summary = reporter.summary();
    if (summary.fail > 0) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(`硬链接预检验收异常：${error.message}`);
    process.exitCode = 1;
  });
