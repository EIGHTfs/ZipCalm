#!/usr/bin/env node
//
// M4 验收脚本：四种格式（zip / tar / tar.gz / tar.zst）的压缩 + 解压 + 往返 hash + 外部工具交叉验证
//              + zip-slip 恶意样本 + 「加目录即注册」+ 复合扩展名最长匹配 + zstd 回退链 + Node 版本自检
//
// 用法：
//   bash scripts/start.sh start
//   node scripts/test-m4-formats.mjs
//
// 验证要点（M4 验收标准要求的三条硬证据）：
// - **假数据 + 每文件 hash 逐文件比对**：压缩前记录 sha256，解压后逐文件比对（正确性核心证据）；
// - **外部工具交叉验证，不自证**：`7z t`（zip）/ `tar -tf`（tar）/ `tar -tzf`（tar.gz）；
//   tar.zst 本机无 zstd 命令，故先用 Node 只做 zstd 解压、再用系统的 `tar -tf` 校验 tar 层；
// - zip-slip：zip 用手写 ZIP 记录、tar 系列用 node-tar 直接写 `../evil` 条目名。

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
const DATA_DIR = path.resolve(PROJECT_ROOT, (runtimeConfig.storage && runtimeConfig.storage.dataDir) || './storage');
const PLUGINS_DIR = path.join(PROJECT_ROOT, 'server', 'plugins', 'formats');
const LOGIN = { username: process.env.ZIPCALM_TEST_USER || 'admin', password: process.env.ZIPCALM_TEST_PASSWORD || 'zipcalm' };

const API_WORK = '/m4-test';
const WORK = path.join(ROOT, 'm4-test');
const FORMATS = [
  { id: 'zip', ext: '.zip', external: '7z-t' },
  { id: 'tar', ext: '.tar', external: 'tar-tf' },
  { id: 'targz', ext: '.tar.gz', external: 'tar-tzf' },
  { id: 'tarzst', ext: '.tar.zst', external: 'tar-tf-after-node-zstd' },
];

let TOKEN = null;
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

function skip(name, reason) {
  skipCount += 1;
  console.log(`SKIP | ${name} | ${reason}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, urlPath, body) {
  const hasBody = body !== undefined;
  const response = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  try {
    return { status: response.status, json: JSON.parse(text) };
  } catch {
    return { status: response.status, json: { ok: false, error: { code: 'NO_ENVELOPE', message: text.slice(0, 160) } } };
  }
}

const TERMINAL = new Set(['done', 'failed', 'aborted', 'interrupted']);

async function waitTask(id, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { json } = await api('GET', `/tasks/${id}`);
    last = json && json.data && json.data.task;
    if (last && TERMINAL.has(last.status)) return last;
    await sleep(200);
  }
  return last;
}

// ===== 夹具（确定性假数据，与 M2 同款思路）=====

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0xffffffff;
  };
}

async function walkFiles(dir, base = dir, acc = new Map()) {
  let dirents = [];
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

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject);
  });
  return hash.digest('hex');
}

async function hashTree(dir) {
  const files = await walkFiles(dir);
  const hashes = new Map();
  for (const [relative, abs] of files) hashes.set(relative, await sha256File(abs));
  return hashes;
}

async function prepareFixture() {
  const srcDir = path.join(WORK, 'src');
  // 整个工作目录都清掉：上一轮的解压产物会让这一轮「首次解压」撞 TARGET_EXISTS
  await fsp.rm(WORK, { recursive: true, force: true });
  await fsp.mkdir(srcDir, { recursive: true });

  const random = createRandom(20261016);
  const layout = [
    { dir: '', count: 2, min: 0, max: 400 },
    { dir: '子目录/深层', count: 6, min: 1024, max: 65536 },
    { dir: '中文 目录/带空格', count: 4, min: 1, max: 4096 },
  ];
  let index = 0;
  for (const group of layout) {
    const target = path.join(srcDir, group.dir);
    await fsp.mkdir(target, { recursive: true });
    for (let i = 0; i < group.count; i += 1) {
      const size = Math.floor(group.min + random() * Math.max(1, group.max - group.min));
      const buffer = Buffer.alloc(size);
      for (let offset = 0; offset < size; offset += 1) buffer[offset] = Math.floor(random() * 256);
      await fsp.writeFile(path.join(target, `file-${String(index).padStart(2, '0')}-${size}B.bin`), buffer);
      index += 1;
    }
  }
  return srcDir;
}

// ===== 外部工具交叉验证 =====

async function verifyWithExternalTools(format, archiveAbsPath) {
  if (format.id === 'zip') {
    try {
      const { stdout } = await execFileAsync('7z', ['t', archiveAbsPath], { timeout: 30000 });
      check(`外部校验 7z t（${format.id}）`, /Everything is Ok/i.test(stdout), stdout.trim().split('\n').slice(-2).join(' / ').slice(0, 100));
    } catch (error) {
      check(`外部校验 7z t（${format.id}）`, false, String(error.stdout || error.message).slice(0, 120));
    }
    return;
  }

  if (format.id === 'tar') {
    try {
      const { stdout } = await execFileAsync('tar', ['-tf', archiveAbsPath], { timeout: 30000 });
      const lines = stdout.trim().split('\n').filter(Boolean);
      check('外部校验 tar -tf（tar）', lines.length >= 10, `${lines.length} 个条目，示例 ${lines[0]}`);
    } catch (error) {
      check('外部校验 tar -tf（tar）', false, String(error.stderr || error.message).slice(0, 120));
    }
    return;
  }

  if (format.id === 'targz') {
    try {
      const { stdout } = await execFileAsync('tar', ['-tzf', archiveAbsPath], { timeout: 30000 });
      const lines = stdout.trim().split('\n').filter(Boolean);
      check('外部校验 tar -tzf（tar.gz）', lines.length >= 10, `${lines.length} 个条目，示例 ${lines[0]}`);
    } catch (error) {
      check('外部校验 tar -tzf（tar.gz）', false, String(error.stderr || error.message).slice(0, 120));
    }
    return;
  }

  // tar.zst：本机没有 zstd 命令（docs/02 已实测）→ 用 Node 只解 zstd 层，再用系统 tar 校验 tar 层
  const probePath = path.join(WORK, 'zstd-probe.tar');
  try {
    const compressed = await fsp.readFile(archiveAbsPath);
    await fsp.writeFile(probePath, zlib.zstdDecompressSync(compressed));
    const { stdout } = await execFileAsync('tar', ['-tf', probePath], { timeout: 30000 });
    const lines = stdout.trim().split('\n').filter(Boolean);
    check('外部校验 tar -tf（tar.zst：Node 只解 zstd 层 + 系统 tar 列内容）', lines.length >= 10, `${lines.length} 个条目，示例 ${lines[0]}`);
  } catch (error) {
    check('外部校验 tar -tf（tar.zst）', false, String(error.message).slice(0, 120));
  }

  // 7z 支持 zstd 的话再补一条外部工具交叉验证
  try {
    const { stdout } = await execFileAsync('7z', ['l', archiveAbsPath], { timeout: 30000 });
    const entries = stdout.trim().split('\n').filter((line) => /\d{4}-\d{2}-\d{2}/.test(line)).length;
    check('外部校验 7z l（tar.zst）', entries >= 10, `${entries} 个条目`);
  } catch (error) {
    skip('外部校验 7z l（tar.zst）', `本机 7z 不支持 zstd：${String(error.stderr || error.message).slice(0, 60)}`);
  }
}

// ===== 恶意样本构造 =====

/** 手写 ZIP 记录（archiver 会把 `../` 规范化，造不出真样本） */
async function writeRawZip(destPath, entries) {
  const nowTs = new Date();
  const time = ((nowTs.getHours() << 11) | (nowTs.getMinutes() << 5) | Math.floor(nowTs.getSeconds() / 2)) & 0xffff;
  const day = (((nowTs.getFullYear() - 1980) << 9) | ((nowTs.getMonth() + 1) << 5) | nowTs.getDate()) & 0xffff;
  const chunks = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.content || 'evil', 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.writeFile(destPath, Buffer.concat([...chunks, centralBuf, eocd]));
}

/**
 * 手写最小 tar（只用于**造恶意样本**）：node-tar 的写入 API 不接受任意条目名，
 * 而 zip-slip 用例必须真的把 `../`、绝对路径写进归档里 —— 所以这里自己拼 512 字节 ustar 头。
 * 只服务测试，生产代码的 tar 读写完全交给 node-tar。
 */
function tarHeader(name, size) {
  const buf = Buffer.alloc(512);
  buf.write(name, 0, 100, 'utf8');
  buf.write('0000644\0', 100, 8, 'ascii');
  buf.write('0000000\0', 108, 8, 'ascii');
  buf.write('0000000\0', 116, 8, 'ascii');
  buf.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  buf.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii');
  buf.write('        ', 148, 8, 'ascii'); // chksum 先占位
  buf.write('0', 156, 1, 'ascii');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return buf;
}

function tarEntry(name, content) {
  const data = Buffer.from(content, 'utf8');
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([tarHeader(name, data.length), padded]);
}

/** 写恶意 tar（按格式套压缩层）：条目名可为 `../x` 或 `/abs/x` */
async function writeRawTar(destPath, compression, entries) {
  const body = Buffer.concat([...entries.map(([name, content]) => tarEntry(name, content)), Buffer.alloc(1024)]);
  const payload = compression === 'gzip' ? zlib.gzipSync(body)
    : compression === 'zstd' ? zlib.zstdCompressSync(body)
      : body;
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.writeFile(destPath, payload);
}

async function zipSlipCase(format, label, archiveAbs, markers) {
  const archiveUser = archiveAbs.replace(ROOT, '').split(path.sep).join('/');
  const created = await api('POST', '/extract/tasks', { path: archiveUser, targetDir: `${archiveUser}-out` });
  const taskId = created.json && created.json.data && created.json.data.task && created.json.data.task.id;
  const task = taskId ? await waitTask(taskId, 30000) : null;
  const code = (task && task.error && task.error.code) || (created.json && created.json.error && created.json.error.code) || null;
  const outsideClean = markers.every((marker) => !fs.existsSync(marker));
  check(`zip-slip 拒绝（${format} / ${label}）`, code === 'PATH_OUT_OF_ROOT', `code=${code || 'none'} status=${task ? task.status : created.status}`);
  check(`zip-slip 目标外无写入（${format} / ${label}）`, outsideClean, `${markers.length} 个哨兵文件均不存在=${outsideClean}`);
}

// ===== 「加目录即注册」 =====

const PROBE_DIR = path.join(PLUGINS_DIR, 'probe-format');
const PROBE_SOURCE = `// 临时探针格式包（验收「加目录即注册」用，测试结束即删）
export default {
  id: 'probe',
  name: 'PROBE',
  ext: '.probe',
  extAliases: [],
  mime: 'application/x-probe',
  levelRange: [0, 1],
  defaultLevel: 0,
  async available() { return true; },
  async estimate(bytes) { return { estimatedBytes: bytes, ratio: 1, basis: 'probe', confidence: 'low' }; },
  async create(ctx) { throw new Error('probe create 未实现（仅用于注册表验证）'); },
  async extract() { throw new Error('probe extract 未实现（仅用于注册表验证）'); },
  async list() { return { entries: [], count: 0, truncated: false }; },
  async test() { return { ok: true, checked: 0, failures: [], strategy: 'read-all' }; },
};
`;

async function formatIds() {
  const { json } = await api('GET', '/formats');
  return ((json && json.data && json.data.formats) || []).map((item) => item.id);
}

async function casePluginByDirectory() {
  await fsp.mkdir(PROBE_DIR, { recursive: true });
  await fsp.writeFile(path.join(PROBE_DIR, 'index.js'), PROBE_SOURCE, 'utf8');
  await sleep(300);
  const withProbe = await formatIds();
  check('加目录即注册：放入新目录后 /formats 自动出现（未改注册代码、未重启）', withProbe.includes('probe'), `formats=${withProbe.join(',')}`);
  const probeDetail = (await api('GET', '/formats')).json.data.formats.find((item) => item.id === 'probe');
  check('新格式元数据正确（ext/mime 均来自该目录）', Boolean(probeDetail && probeDetail.ext === '.probe' && probeDetail.mime === 'application/x-probe'), JSON.stringify(probeDetail && { ext: probeDetail.ext, mime: probeDetail.mime }));

  await fsp.rm(PROBE_DIR, { recursive: true, force: true });
  await sleep(300);
  const withoutProbe = await formatIds();
  check('删掉目录后 /formats 自动消失', !withoutProbe.includes('probe'), `formats=${withoutProbe.join(',')}`);
}

// ===== 复合扩展名最长匹配 =====

async function caseExtensionMatching() {
  const { createRegistry } = await import(path.join(PROJECT_ROOT, 'server/core/compress/registry.js'));
  const logger = { info() {}, warn() {}, error() {} };
  const registry = createRegistry({ logger });
  await registry.discover();
  const cases = [
    ['/x.tar.gz', 'targz'],
    ['/x.tgz', 'targz'],
    ['/x.tar.zst', 'tarzst'],
    ['/x.tzst', 'tarzst'],
    ['/x.tar', 'tar'],
    ['/x.zip', 'zip'],
  ];
  for (const [file, expected] of cases) {
    // 传完整文件名：注册表按"整体后缀最长匹配"判定（x.tar.gz 必须命中 targz 而不是 tar/gz）
    const plugin = registry.byExtension(file);
    check(`扩展名匹配 ${file} → ${expected}`, Boolean(plugin && plugin.id === expected), `实际 ${plugin ? plugin.id : 'null'}`);
  }
  check('最长匹配优先：x.tar.gz 不被 .tar / .gz 抢走（除 targz 外没有更短匹配）', Boolean(registry.byExtension('.tar.gz') && registry.byExtension('.tar.gz').id === 'targz'));
}

// ===== Node 版本自检（单测 + 端到端模拟低版本）=====

async function caseNodeVersionGuard() {
  const { checkNodeVersion } = await import(path.join(PROJECT_ROOT, 'server/lib/runtime-guard.js'));
  const ok = checkNodeVersion(undefined, '22.23.3');
  const low = checkNodeVersion(undefined, '22.10.0');
  check('版本自检：满足时通过', ok.ok === true, ok.message);
  check('版本自检：不满足时给出要求与当前版本', low.ok === false && low.message.includes('22.15.0') && low.message.includes('22.10.0'), low.message.split('\n')[0]);

  // 端到端：覆盖 process.versions.node 后启动 boot.js，应退出码 1 且 stderr 说清原因
  const script = "Object.defineProperty(process.versions,'node',{value:'22.10.0'});import('" + path.join(PROJECT_ROOT, 'server/boot.js').replace(/\\/g, '/') + "');";
  try {
    await execFileAsync(process.execPath, ['-e', script], { cwd: PROJECT_ROOT, timeout: 20000 });
    check('低版本端到端：拒绝启动（预期非 0 退出）', false, '居然正常退出了');
  } catch (error) {
    const stderr = String(error.stderr || '');
    check('低版本端到端：拒绝启动并说明原因', error.code !== 0 && stderr.includes('22.15.0') && stderr.includes('22.10.0'), stderr.split('\n').slice(0, 2).join(' / ').slice(0, 140));
  }
}

// ===== zstd 回退链 =====

async function restartService(env = {}) {
  const envPrefix = Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ');
  await execFileAsync('bash', ['-c', `${envPrefix} bash scripts/start.sh restart`], { cwd: PROJECT_ROOT, timeout: 90000 }).catch(() => {});
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  return false;
}

async function caseZstdFallbackChain() {
  // ① 内置可用（默认）：已由前面的往返用例覆盖，这里只记录
  const builtin = (await api('GET', '/formats')).json.data.formats.find((item) => item.id === 'tarzst');
  check('zstd 首选：Node 内置可用时 tarzst available=true', Boolean(builtin && builtin.available === true), `available=${builtin && builtin.available}`);

  // ② 禁用内置 + 指向垫片 → 走"系统命令"回退，且仍能往返
  // 垫片必须放在**可执行挂载**上：工作区是 noexec（依赖装在 zipcalm-build 就是这个原因），
  // 放 storage/ 下即使有 +x 也会被 EACCES 拒绝，回退链验证会变成假阴性。
  const buildDir = path.dirname(fs.realpathSync(path.join(PROJECT_ROOT, 'node_modules')));
  const shimPath = path.join(buildDir, 'm4-tmp', 'zstd-shim');
  await fsp.mkdir(path.dirname(shimPath), { recursive: true });
  await fsp.writeFile(shimPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(PROJECT_ROOT, 'scripts/helpers/zstd-shim.mjs'))} "$@"\n`, 'utf8');
  await fsp.chmod(shimPath, 0o755);

  await restartService({ ZIPCALM_DISABLE_BUILTIN_ZSTD: '1', ZC_ZSTD_BIN: shimPath });
  await api('POST', '/auth/login', LOGIN).then((r) => { TOKEN = r.json.data.token; });
  const viaExternal = (await api('GET', '/formats')).json.data.formats.find((item) => item.id === 'tarzst');
  check('回退链：禁用内置 + 指定外部 zstd → available=true（走外部命令）', Boolean(viaExternal && viaExternal.available === true), `available=${viaExternal && viaExternal.available}`);

  const roundtrip = await roundTrip('tarzst', { suffix: '-ext', skipExternal: true });
  check('回退链：外部命令路径下 .tar.zst 往返 hash 一致', roundtrip.ok, roundtrip.detail);

  // ③ 禁用内置 + 外部也不存在 → 置灰 + 原因（而不是崩）
  await restartService({ ZIPCALM_DISABLE_BUILTIN_ZSTD: '1', ZC_ZSTD_BIN: '/nonexistent/zstd-not-here' });
  await api('POST', '/auth/login', LOGIN).then((r) => { TOKEN = r.json.data.token; });
  const unavailable = (await api('GET', '/formats')).json.data.formats.find((item) => item.id === 'tarzst');
  check('回退链：都不可用 → available=false 且给出原因', Boolean(unavailable && unavailable.available === false && unavailable.unavailableReason), `reason=${unavailable && String(unavailable.unavailableReason).slice(0, 80)}`);

  const rejected = await api('POST', '/compress/tasks', { sources: [`${API_WORK}/src`], mode: 'bundle', format: 'tarzst' });
  const code = rejected.json && rejected.json.error && rejected.json.error.code;
  check('不可用格式：创建任务被明确拒绝（不崩、不静默）', rejected.status === 503 && code === 'FORMAT_UNAVAILABLE', `HTTP ${rejected.status} code=${code}`);

  // ④ 恢复默认（内置）
  await restartService({});
  await api('POST', '/auth/login', LOGIN).then((r) => { TOKEN = r.json.data.token; });
  const restored = (await api('GET', '/formats')).json.data.formats.find((item) => item.id === 'tarzst');
  check('恢复默认：内置 zstd 重新可用', Boolean(restored && restored.available === true), `available=${restored && restored.available}`);
}

// ===== 单个格式的往返 =====

async function roundTrip(formatId, options = {}) {
  const suffix = options.suffix || '';
  const sourceUser = `${API_WORK}/src`;
  const before = await hashTree(path.join(WORK, 'src'));

  const compressed = await api('POST', '/compress/tasks', { sources: [sourceUser], mode: 'bundle', format: formatId, options: { outputDir: `${API_WORK}/packages` } });
  if (!compressed.json || !compressed.json.ok) return { ok: false, detail: `创建失败 ${JSON.stringify(compressed.json.error)}` };
  const task = await waitTask(compressed.json.data.task.id);
  const pkg = task && task.result && task.result.packages && task.result.packages[0];
  if (!task || task.status !== 'done' || !pkg) return { ok: false, detail: `任务 ${task && task.status} ${task && task.error && task.error.code}` };

  const archiveUser = pkg.outputPath;
  const archiveAbs = path.join(ROOT, ...archiveUser.split('/').filter(Boolean));
  const archiveOk = fs.existsSync(archiveAbs) && archiveAbs.endsWith(FORMATS.find((item) => item.id === formatId).ext);

  const targetUser = `${API_WORK}/out-${formatId}${suffix}`;
  const extracted = await api('POST', '/extract/tasks', { path: archiveUser, targetDir: targetUser });
  if (!extracted.json || !extracted.json.ok) return { ok: false, detail: `解压创建失败 ${JSON.stringify(extracted.json.error)}` };
  const extractTask = await waitTask(extracted.json.data.task.id);
  if (!extractTask || extractTask.status !== 'done') return { ok: false, detail: `解压 ${extractTask && extractTask.status} ${extractTask && extractTask.error && extractTask.error.code}` };

  const after = await hashTree(path.join(ROOT, ...targetUser.split('/').filter(Boolean)));
  const mismatched = [];
  for (const [relative, hash] of before) {
    const actual = after.get(`src/${relative}`) || after.get(relative);
    if (actual !== hash) mismatched.push(relative);
  }
  const same = mismatched.length === 0 && after.size === before.size;
  return {
    ok: same && archiveOk,
    detail: `${before.size - mismatched.length}/${before.size} 一致；产物 ${path.basename(archiveAbs)}；校验 ${pkg.verifyStrategy || '-'}`,
    archiveAbs,
    verifyStrategy: pkg.verifyStrategy,
    entries: pkg.checks,
  };
}

// ===== 主流程 =====

async function main() {
  console.log('ZipCalm M4 验收（tar / tar.gz / tar.zst 多格式 + 注册表 + 回退链 + 版本自检）');
  console.log(`API：${BASE}\n存储根：${ROOT}\n`);

  const login = await api('POST', '/auth/login', LOGIN);
  TOKEN = login.json && login.json.data && login.json.data.token;
  check('登录拿到 Bearer Token', Boolean(TOKEN));

  await prepareFixture();
  await fsp.mkdir(path.join(WORK, 'packages'), { recursive: true });
  const beforeCount = (await hashTree(path.join(WORK, 'src'))).size;
  console.log(`    假数据：${beforeCount} 个文件（确定性种子）\n`);

  // ① 四格式往返 + 外部交叉验证
  for (const format of FORMATS) {
    const result = await roundTrip(format.id);
    check(`往返 hash 逐文件一致（${format.id}）`, result.ok, result.detail);
    if (result.archiveAbs) await verifyWithExternalTools(format, result.archiveAbs);
  }

  // ② zip-slip：四种格式各一组
  const evilRoot = path.join(WORK, 'evil');
  const zipEvil = path.join(evilRoot, 'zip-evil.zip');
  await writeRawZip(zipEvil, [{ name: '../zip-slip-evil.txt' }, { name: '/abs-evil.txt' }]);
  await zipSlipCase('zip', '../ 与绝对路径', zipEvil, [path.join(ROOT, 'zip-slip-evil.txt'), path.join(ROOT, 'abs-evil.txt')]);

  for (const spec of [{ id: 'tar', compression: 'none' }, { id: 'targz', compression: 'gzip' }, { id: 'tarzst', compression: 'zstd' }]) {
    const evilAbs = path.join(evilRoot, `${spec.id}-evil.${spec.compression === 'none' ? 'tar' : spec.compression === 'gzip' ? 'tar.gz' : 'tar.zst'}`);
    await writeRawTar(evilAbs, spec.compression, [
      ['../tar-slip-evil.txt', 'evil'],
      ['/tmp/zc-m4-tar-abs-evil.txt', 'evil'],
    ]);
    await zipSlipCase(spec.id, '../ 与绝对路径', evilAbs, [path.join(WORK, 'evil', 'tar-slip-evil.txt'), '/tmp/zc-m4-tar-abs-evil.txt']);
  }

  // ③ 注册表：加目录即注册 + 复合扩展名
  await casePluginByDirectory();
  await caseExtensionMatching();

  // ④ 启动自检
  await caseNodeVersionGuard();

  // ⑤ zstd 回退链（会重启服务，放最后）
  await caseZstdFallbackChain();

  await cleanupArtefacts();

  console.log(`\n── 汇总 ──\nPASS ${passCount} / FAIL ${failCount} / SKIP ${skipCount}`);
  if (failures.length > 0) {
    console.log(`失败项：${failures.join('；')}`);
    process.exitCode = 1;
  }
}

/** 收尾清理：测试产物（存储根下的 /m4-test）与回退链垫片；设 ZIPCALM_M4_KEEP=1 可保留 */
async function cleanupArtefacts() {
  if (process.env.ZIPCALM_M4_KEEP === '1') {
    console.log('（ZIPCALM_M4_KEEP=1：保留测试产物便于人工复核）');
    return;
  }
  await fsp.rm(WORK, { recursive: true, force: true }).catch(() => {});
  const buildDir = path.dirname(fs.realpathSync(path.join(PROJECT_ROOT, 'node_modules')));
  await fsp.rm(path.join(buildDir, 'm4-tmp'), { recursive: true, force: true }).catch(() => {});
}

main().catch(async (error) => {
  console.error(`脚本异常：${error && error.stack ? error.stack : error}`);
  // 异常退出也要把服务恢复到默认环境，避免留下"禁用内置 zstd"的实例
  await execFileAsync('bash', ['-c', 'bash scripts/start.sh restart'], { cwd: PROJECT_ROOT, timeout: 90000 }).catch(() => {});
  process.exitCode = 1;
});
