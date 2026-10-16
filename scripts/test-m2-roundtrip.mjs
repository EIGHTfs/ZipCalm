#!/usr/bin/env node
//
// M2 验收脚本：压缩 / 解压 往返一致性 + zip-slip + 外部工具交叉验证 + log-only 删除证据
//
// 用法：
//   bash scripts/start.sh start
//   node scripts/test-m2-roundtrip.mjs                # 默认 http://127.0.0.1:<配置端口>
//   ZIPCALM_BASE=http://10.0.0.5:3010/api/v1 node scripts/test-m2-roundtrip.mjs
//
// 设计要点（验收方式）：
// - **假数据 + hash 往返**：确定性生成（种子固定，不随机）→ 记录每文件 sha256 → 压缩 → 解压 → 逐文件比对；
// - **外部工具交叉验证**：生成的 zip 交给系统 `7z t` / `zip -T` 校验，不靠自家代码自证；
// - **zip-slip**：手工构造 `../`、绝对路径、symlink 三种恶意包，断言被拒且目标目录外无写入；
// - **删除受 delete.mode 约束**：默认 log-only 只记日志不真删 —— 断言文件仍在 + 删除日志有记录。

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ===== 配置：端口与存储根都从运行期配置读（不写死）=====

const runtimeConfig = await (async () => {
  try {
    return JSON.parse(await fsp.readFile(path.join(PROJECT_ROOT, 'storage', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
})();

const PORT = process.env.ZIPCALM_PORT || (runtimeConfig.server && runtimeConfig.server.port) || 3010;
const BASE = process.env.ZIPCALM_BASE || `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(PROJECT_ROOT, (runtimeConfig.storage && runtimeConfig.storage.root) || './storage/fs-root');
const API_WORK = '/m2-test'; // 存储根内的测试工作目录（API 视角）
const WORK = path.join(ROOT, 'm2-test');
const LOGIN = { username: process.env.ZIPCALM_TEST_USER || 'admin', password: process.env.ZIPCALM_TEST_PASSWORD || 'zipcalm' };

let passCount = 0;
let failCount = 0;
let skipCount = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passCount += 1;
    console.log(`PASS | ${name}${detail ? ` | ${detail}` : ''}`);
  } else {
    failCount += 1;
    failures.push(name);
    console.log(`FAIL | ${name}${detail ? ` | ${detail}` : ''}`);
  }
}

/** 环境缺工具时跳过（不算失败，但必须显式说明原因，避免"静默通过"） */
function skip(name, reason) {
  skipCount += 1;
  console.log(`SKIP | ${name} | ${reason}`);
}

// ===== HTTP =====

let TOKEN = null;

async function api(method, urlPath, body) {
  const response = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, error: { code: 'NO_ENVELOPE', message: text.slice(0, 120) } };
  }
  return { status: response.status, json };
}

const TERMINAL = new Set(['done', 'failed', 'aborted', 'interrupted']);

async function waitTask(id, timeoutMs = 60000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const { json } = await api('GET', `/tasks/${id}`);
    const task = json && json.data && json.data.task;
    if (!task) return null;
    if (TERMINAL.has(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

// ===== 假数据（确定性）=====

/** 固定种子的 xorshift32：保证每次运行生成同样的字节，便于 hash 比对可复现 */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject);
  });
  return hash.digest('hex');
}

/** 递归收集目录下所有文件（相对路径 → 绝对路径）；目录不存在时返回空集合（由断言去判失败） */
async function walkFiles(dir, base = dir, acc = new Map()) {
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const dirent of dirents) {
    const abs = path.join(dir, dirent.name);
    if (dirent.isDirectory()) await walkFiles(abs, base, acc);
    else if (dirent.isFile()) acc.set(path.relative(base, abs).split(path.sep).join('/'), abs);
  }
  return acc;
}

async function hashTree(dir) {
  const files = await walkFiles(dir);
  const hashes = new Map();
  for (const [relative, abs] of files) hashes.set(relative, await sha256File(abs));
  return hashes;
}

async function prepareFixture() {
  await fsp.rm(WORK, { recursive: true, force: true });
  const srcDir = path.join(WORK, 'src');
  await fsp.mkdir(srcDir, { recursive: true });

  const random = createRandom(20261016);
  const layout = [
    { dir: '', count: 3, minSize: 0, maxSize: 512 },
    { dir: '子目录A', count: 12, minSize: 1024, maxSize: 65536 },
    { dir: '子目录B/深层', count: 8, minSize: 65536, maxSize: 300000 },
    { dir: 'empty-dir', count: 0, minSize: 0, maxSize: 0 },
    { dir: '中文目录/带空格 的目录', count: 5, minSize: 1, maxSize: 4096 },
  ];

  let index = 0;
  for (const group of layout) {
    const target = path.join(srcDir, group.dir);
    await fsp.mkdir(target, { recursive: true });
    for (let i = 0; i < group.count; i += 1) {
      const size = Math.floor(group.minSize + random() * Math.max(1, group.maxSize - group.minSize));
      const name = `file-${String(index).padStart(3, '0')}-${size}B.bin`;
      const buffer = Buffer.alloc(size);
      for (let offset = 0; offset < size; offset += 1) buffer[offset] = Math.floor(random() * 256);
      await fsp.writeFile(path.join(target, name), buffer);
      index += 1;
    }
    if (group.count === 0) {
      await fsp.writeFile(path.join(target, '.keep'), '空目录占位\n');
    }
  }
  return { srcDir, fileCount: index + 1 };
}

// ===== 恶意 zip 构造（zip-slip 用例）=====
//
// 为什么不用 archiver：实测它会把 `../evil.txt` **规范化**成 `evil.txt`（7z l 实证），
// 那样根本造不出真实的攻击样本 —— 门禁/安全用例绝不能是"假攻击"。
// 因此这里手写最小 ZIP 记录（local header + central directory + EOCD），
// **仅用于测试夹具**；生产代码不解析 ZIP，读写都交给 archiver / unzipper。

/** 组装一个 ZIP 文件（支持任意条目名与 unix 模式，用于制造 ../、绝对路径、symlink 等样本） */
async function writeRawZip(destPath, entries) {
  const now = new Date();
  const time = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xffff;
  const day = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  const chunks = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const isSymlink = entry.type === 'symlink';
    const data = Buffer.from(isSymlink ? entry.target : (entry.content ?? 'x'), 'utf8');
    const method = isSymlink ? 0 : 8; // symlink 用 store，普通文件用 deflate
    const compressed = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data) >>> 0;
    const externalAttr = isSymlink ? ((0o120777 << 16) >>> 0) : ((0o100644 << 16) >>> 0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(externalAttr, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.writeFile(destPath, Buffer.concat([...chunks, centralBuf, eocd]));
}

// ===== 主流程 =====

async function main() {
  console.log(`ZipCalm M2 验收（往返 + zip-slip + 外部工具 + 删除模式）`);
  console.log(`API：${BASE}\n存储根：${ROOT}\n`);

  // 0) 登录
  const login = await api('POST', '/auth/login', LOGIN);
  TOKEN = login.json && login.json.data && login.json.data.token;
  check('登录拿到 Bearer Token', Boolean(TOKEN), TOKEN ? `token=${TOKEN.slice(0, 8)}…` : JSON.stringify(login.json));

  // 1) 假数据 + 记录 hash
  const fixture = await prepareFixture();
  const before = await hashTree(path.join(WORK, 'src'));
  check('生成确定性假数据并记录每文件 hash', before.size >= 28, `${before.size} 个文件`);

  // 2) 压缩
  const compress = await api('POST', '/compress/tasks', {
    sources: [`${API_WORK}/src`],
    mode: 'bundle',
    format: 'zip',
  });
  const compressTaskId = compress.json && compress.json.data && compress.json.data.task && compress.json.data.task.id;
  check('创建压缩任务', Boolean(compressTaskId), `HTTP ${compress.status}`);

  const compressTask = compressTaskId ? await waitTask(compressTaskId) : null;
  const pkg = compressTask && compressTask.result && compressTask.result.packages && compressTask.result.packages[0];
  check('压缩任务完成', Boolean(compressTask && compressTask.status === 'done'), compressTask ? `status=${compressTask.status} phase=${compressTask.phase}` : 'timeout');
  check('压缩产物通过完整性校验（CRC）', Boolean(pkg && pkg.verified), pkg ? `strategy=${pkg.verifyStrategy} entries=${pkg.checkedEntries}` : '-');

  const archiveUserPath = pkg ? pkg.outputPath : `${API_WORK}/src.zip`;
  const archiveAbsPath = path.join(ROOT, ...archiveUserPath.split('/').filter(Boolean));
  check('产物落在预期路径', fs.existsSync(archiveAbsPath), archiveUserPath);
  check('无残留 .part 半成品', !fs.existsSync(`${archiveAbsPath}.part`));

  // 3) 外部工具交叉验证（不靠自家代码自证）
  try {
    const { stdout } = await execFileAsync('7z', ['t', archiveAbsPath], { timeout: 30000 });
    check('7z t 外部校验通过', /Everything is Ok/i.test(stdout), stdout.trim().split('\n').slice(-2).join(' / ').slice(0, 120));
  } catch (error) {
    check('7z t 外部校验通过', false, (error.stdout || error.message || '').toString().slice(0, 120));
  }
  try {
    await execFileAsync('unzip', ['-t', archiveAbsPath], { timeout: 30000 });
    check('unzip -t 外部校验通过', true);
  } catch (error) {
    // 本机可能没装 unzip（实测 Synology 上只有 7z/zip）；缺工具时显式跳过而不是判失败
    const missing = error && (error.code === 'ENOENT' || /command not found/i.test(String(error.stderr || error.message)));
    if (missing) skip('unzip -t 外部校验通过', '本机未安装 unzip（改用 7z t 交叉验证）');
    else check('unzip -t 外部校验通过', false, (error.stderr || error.message || '').toString().slice(0, 120));
  }

  // 4) 解压
  const extract = await api('POST', '/extract/tasks', {
    path: archiveUserPath,
    targetDir: `${API_WORK}/out`,
  });
  const extractTaskId = extract.json && extract.json.data && extract.json.data.task && extract.json.data.task.id;
  check('创建解压任务', Boolean(extractTaskId), `HTTP ${extract.status}`);

  const extractTask = extractTaskId ? await waitTask(extractTaskId) : null;
  check('解压任务完成', Boolean(extractTask && extractTask.status === 'done'), extractTask ? `status=${extractTask.status} phase=${extractTask.phase}` : 'timeout');

  // 4.5) 回归断言：任务响应体**不得包含绝对路径**（曾出现 sources[].absPath 泄漏存储根绝对路径）
  const taskBodies = [];
  for (const [label, id] of [['详情-压缩', compressTaskId], ['详情-解压', extractTaskId]]) {
    if (!id) continue;
    const response = await api('GET', `/tasks/${id}`);
    taskBodies.push([label, JSON.stringify(response.json)]);
  }
  const listResponse = await api('GET', '/tasks?limit=50');
  taskBodies.push(['列表', JSON.stringify(listResponse.json)]);

  const leakFindings = [];
  for (const [label, text] of taskBodies) {
    if (text.includes(ROOT)) leakFindings.push(`${label}:含存储根绝对路径`);
    if (text.includes('absPath')) leakFindings.push(`${label}:含 absPath 字段`);
  }
  check(
    '任务响应不含绝对路径（防 sources[].absPath 泄漏回归）',
    leakFindings.length === 0,
    leakFindings.length === 0 ? `已扫描 ${taskBodies.length} 个响应体` : leakFindings.join('；'),
  );

  // 5) 往返 hash 逐文件比对（正确性核心证据）
  const outDir = path.join(WORK, 'out');
  const after = await hashTree(outDir);
  const mismatched = [];
  for (const [relative, hash] of before) {
    const actual = after.get(`src/${relative}`) || after.get(relative);
    if (actual !== hash) mismatched.push(relative);
  }
  const sameCount = before.size - mismatched.length;
  check(
    '往返 hash 逐文件一致',
    mismatched.length === 0 && after.size === before.size,
    `${sameCount}/${before.size} 一致；解压侧文件数 ${after.size}${mismatched.length ? `；不一致示例 ${mismatched.slice(0, 3).join(', ')}` : ''}`,
  );

  // 6) zip-slip：手写 ZIP 记录构造真实攻击样本（archiver 会把 ../ 规范化，造不出真样本）
  const evilRoot = path.join(WORK, 'evil');
  const evilCases = [
    { id: '相对路径逃逸(../)', entries: [{ name: '../zip-slip-evil.txt' }], markers: [path.join(ROOT, 'zip-slip-evil.txt')] },
    { id: '嵌套相对路径逃逸', entries: [{ name: 'sub/../../zip-slip-nested.txt' }], markers: [path.join(ROOT, 'zip-slip-nested.txt')] },
    { id: '绝对路径条目', entries: [{ name: '/abs-evil.txt' }], markers: [path.join(ROOT, 'abs-evil.txt'), path.join(ROOT, 'm2-test', 'abs-evil.txt')] },
    { id: '盘符条目', entries: [{ name: 'C:/drive-evil.txt' }], markers: [] },
    { id: '符号链接逃逸', entries: [{ type: 'symlink', name: 'sym-evil', target: '/etc/passwd' }], markers: [] },
  ];

  for (const evil of evilCases) {
    const evilAbs = path.join(evilRoot, `${evil.id.replace(/[^\w\u4e00-\u9fa5-]/g, '_')}.zip`);
    const outDir = path.join(evilRoot, `${path.basename(evilAbs, '.zip')}-out`);
    await writeRawZip(evilAbs, evil.entries);
    const evilUser = `${API_WORK}/evil/${path.basename(evilAbs)}`;

    const created = await api('POST', '/extract/tasks', { path: evilUser, targetDir: `${API_WORK}/evil/${path.basename(evilAbs, '.zip')}-out` });
    const evilTaskId = created.json && created.json.data && created.json.data.task && created.json.data.task.id;
    const evilTask = evilTaskId ? await waitTask(evilTaskId) : null;
    const rejectedCode = (evilTask && evilTask.error && evilTask.error.code) || (created.json && created.json.error && created.json.error.code) || null;
    const rejected = rejectedCode === 'PATH_OUT_OF_ROOT';
    const outsideClean = evil.markers.every((marker) => !fs.existsSync(marker));
    const outDirClean = !fs.existsSync(outDir) || (await fsp.readdir(outDir)).length === 0;

    check(`zip-slip 拒绝：${evil.id}`, rejected, `code=${rejectedCode || 'none'} status=${evilTask ? evilTask.status : created.status}`);
    check(`zip-slip 目标外无写入：${evil.id}`, outsideClean && outDirClean, `markers=${evil.markers.length} outDirEmpty=${outDirClean}`);
  }

  // 对照用例（防假阳性）：同样是"手写 ZIP"，但条目名合法 → 必须解压成功
  const benignAbs = path.join(evilRoot, 'benign-raw.zip');
  await writeRawZip(benignAbs, [{ name: 'ok.txt', content: 'benign-raw-zip-ok' }]);
  const benign = await api('POST', '/extract/tasks', { path: `${API_WORK}/evil/benign-raw.zip`, targetDir: `${API_WORK}/evil/benign-out` });
  const benignTaskId = benign.json && benign.json.data && benign.json.data.task && benign.json.data.task.id;
  const benignTask = benignTaskId ? await waitTask(benignTaskId) : null;
  const benignOkFile = path.join(evilRoot, 'benign-out', 'ok.txt');
  check(
    '对照：合法原始 zip 能正常解压（防假阳性）',
    Boolean(benignTask && benignTask.status === 'done') && fs.existsSync(benignOkFile) && (await fsp.readFile(benignOkFile, 'utf8')) === 'benign-raw-zip-ok',
    benignTask ? `status=${benignTask.status}` : 'timeout',
  );

  // 7) 损坏归档 → 契约错误码
  const brokenAbs = path.join(WORK, 'broken.zip');
  const goodBuffer = await fsp.readFile(archiveAbsPath);
  await fsp.writeFile(brokenAbs, goodBuffer.subarray(0, Math.max(64, Math.floor(goodBuffer.length / 2))));
  const broken = await api('POST', '/extract/tasks', { path: `${API_WORK}/broken.zip`, targetDir: `${API_WORK}/broken-out` });
  const brokenCode = (broken.json && broken.json.error && broken.json.error.code) || null;
  check('损坏归档 → ARCHIVE_CORRUPTED', brokenCode === 'ARCHIVE_CORRUPTED', `HTTP ${broken.status} code=${brokenCode}`);

  // 8) 删除：log-only 只记日志不真删（压缩删原文件 + 解压删压缩包两个方向）
  const srcSnapshot = (await walkFiles(path.join(WORK, 'src'))).size;
  // 日志文件名必须按**本地日期**拼：服务端用 getFullYear/getMonth/getDate（本地），
  // 这里若用 toISOString()（UTC）在 UTC+8 的 00:00–08:00 会差一天，测试会盯错文件而假失败。
  const today = new Date();
  const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const deleteLogPath = path.join(PROJECT_ROOT, 'storage', 'logs', `delete-${stamp}.jsonl`);
  const logSizeBefore = fs.existsSync(deleteLogPath) ? (await fsp.stat(deleteLogPath)).size : 0;

  // 输出目录必须**已存在**（服务端不会替用户静默建目录）——先建好再发任务
  const deleteOutputDir = path.join(WORK, 'del-test');
  await fsp.mkdir(deleteOutputDir, { recursive: true });

  const compressDelete = await api('POST', '/compress/tasks', {
    sources: [`${API_WORK}/src`],
    mode: 'bundle',
    format: 'zip',
    options: { keepOriginal: false, deleteConfirmed: true, outputDir: `${API_WORK}/del-test` },
  });
  if (!(compressDelete.json && compressDelete.json.ok)) {
    check('创建"压缩后删除"任务', false, `HTTP ${compressDelete.status} ${JSON.stringify(compressDelete.json && compressDelete.json.error)}`);
  }
  const delTaskId = compressDelete.json && compressDelete.json.data && compressDelete.json.data.task && compressDelete.json.data.task.id;
  const delTask = delTaskId ? await waitTask(delTaskId) : null;
  const srcStillThere = (await walkFiles(path.join(WORK, 'src'))).size === srcSnapshot;
  check('keepOriginal=false + deleteConfirmed=true：删除阶段已执行', Boolean(delTask && delTask.delete && delTask.delete.status === 'logged'), delTask ? `delete.status=${delTask.delete && delTask.delete.status} mode=${delTask.delete && delTask.delete.mode}` : 'timeout');
  check('log-only：原文件未被真删', srcStillThere, `源文件数 ${srcSnapshot}`);

  const extractDelete = await api('POST', '/extract/tasks', {
    path: archiveUserPath,
    targetDir: `${API_WORK}/out2`,
    options: { deleteArchiveAfterExtract: true, deleteConfirmed: true },
  });
  const exDelTaskId = extractDelete.json && extractDelete.json.data && extractDelete.json.data.task && extractDelete.json.data.task.id;
  const exDelTask = exDelTaskId ? await waitTask(exDelTaskId) : null;
  check('解压后删除压缩包：删除阶段已执行', Boolean(exDelTask && exDelTask.delete && exDelTask.delete.status === 'logged'), exDelTask ? `delete.status=${exDelTask.delete && exDelTask.delete.status}` : 'timeout');
  check('log-only：压缩包未被真删', fs.existsSync(archiveAbsPath), archiveUserPath);

  const logSizeAfter = fs.existsSync(deleteLogPath) ? (await fsp.stat(deleteLogPath)).size : 0;
  let logLines = [];
  if (fs.existsSync(deleteLogPath)) {
    logLines = (await fsp.readFile(deleteLogPath, 'utf8')).trim().split('\n').filter(Boolean).slice(-4);
  }
  check('删除日志已写入（log-only 证据）', logSizeAfter > logSizeBefore && logLines.some((line) => line.includes('skipped-log-only')), `+${logSizeAfter - logSizeBefore} 字节`);
  if (logLines.length > 0) {
    console.log('    最近删除日志：');
    for (const line of logLines) console.log(`      ${line.slice(0, 200)}`);
  }

  // 9) 取消（可选冒烟）：创建一个大任务后立即取消
  const cancelTarget = await api('POST', '/compress/tasks', { sources: [`${API_WORK}/src`], mode: 'bundle', format: 'zip', options: { outputDir: `${API_WORK}/cancel-test` } });
  const cancelId = cancelTarget.json && cancelTarget.json.data && cancelTarget.json.data.task && cancelTarget.json.data.task.id;
  if (cancelId) {
    const cancelResult = await api('POST', `/tasks/${cancelId}/cancel`, {});
    const cancelledCode = (cancelResult.json && cancelResult.json.error && cancelResult.json.error.code) || null;
    const cancelOk = cancelResult.json && (cancelResult.json.ok === true || cancelledCode === 'TASK_NOT_CANCELLABLE');
    check('取消接口可用（已完成则返回 TASK_NOT_CANCELLABLE）', cancelOk, `HTTP ${cancelResult.status} code=${cancelledCode || 'ok'}`);
  }

  console.log(`\n── 汇总 ──\nPASS ${passCount} / FAIL ${failCount} / SKIP ${skipCount}`);
  if (failures.length > 0) {
    console.log(`失败项：${failures.join('；')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`脚本异常：${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
