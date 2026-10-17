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

import fsp from 'node:fs/promises';
import path from 'node:path';

import { createRandom, hashTree, walkFiles, writeRawZip } from './helpers/archive-fixtures.mjs';
import { PROJECT_ROOT, execFileAsync, fileSizeOrZero, pathExists } from './helpers/script-env.mjs';
import { loadRuntimeConfig } from './helpers/test-config.mjs';
import { createReporter } from './helpers/test-report.mjs';



// ===== 配置：端口与存储根都从运行期配置读（不写死）=====

const runtimeConfig = await loadRuntimeConfig(PROJECT_ROOT);

const PORT = process.env.ZIPCALM_PORT || (runtimeConfig.server && runtimeConfig.server.port) || 3010;
const BASE = process.env.ZIPCALM_BASE || `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(PROJECT_ROOT, (runtimeConfig.storage && runtimeConfig.storage.root) || './storage/fs-root');
const API_WORK = '/m2-test'; // 存储根内的测试工作目录（API 视角）
const WORK = path.join(ROOT, 'm2-test');
const LOGIN = { username: process.env.ZIPCALM_TEST_USER || 'admin', password: process.env.ZIPCALM_TEST_PASSWORD || 'zipcalm' };

// 断言/跳过/汇总走共用报告器（多套脚本同一份实现；输出格式与 test-all.sh 的提取正则一致）
/** HTTP 调用超时（毫秒）：服务僵死/半开连接时脚本不能永久挂住 */
const HTTP_TIMEOUT_MS = 15000;
/** 任务等待：单任务最长等多久、状态轮询间隔 */
const DEFAULT_TASK_TIMEOUT_MS = 60000;
const TASK_POLL_INTERVAL_MS = 250;
const reporter = createReporter();
const { check, skip } = reporter;

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
    // 超时兜底：服务僵死/半开连接时不能让脚本永久挂住（测试脚本也要有超时纪律）
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
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

async function waitTask(id, timeoutMs = DEFAULT_TASK_TIMEOUT_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const { json } = await api('GET', `/tasks/${id}`);
    const task = json && json.data && json.data.task;
    if (!task) return null;
    if (TERMINAL.has(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, TASK_POLL_INTERVAL_MS));
  }
  return null;
}

// ===== 假数据（确定性）=====
//
// createRandom / walkFiles / hashTree 都从 helpers/archive-fixtures.mjs 引入：
// M4 当初就是照这套实现拆出去的，两份各留一份只会漂移（例如种子或 hash 口径改一处忘一处）。

/** M2 的夹具布局：0 字节文件、超大文件、空目录、中文/空格路径都要有 */
const FIXTURE_LAYOUT = [
  { dir: '', count: 3, minSize: 0, maxSize: 512 },
  { dir: '子目录A', count: 12, minSize: 1024, maxSize: 65536 },
  { dir: '子目录B/深层', count: 8, minSize: 65536, maxSize: 300000 },
  { dir: 'empty-dir', count: 0, minSize: 0, maxSize: 0 },
  { dir: '中文目录/带空格 的目录', count: 5, minSize: 1, maxSize: 4096 },
];
/** 夹具随机种子：固定值保证每次生成同样的字节，便于 hash 比对可复现 */
const FIXTURE_SEED = 20261016;
/** 假数据字节取值范围（0~255）；文件名序号对齐宽度 */
const BYTE_VALUES = 256;
const INDEX_PAD_WIDTH = 3;

async function prepareFixture() {
  await fsp.rm(WORK, { recursive: true, force: true });
  const srcDir = path.join(WORK, 'src');
  await fsp.mkdir(srcDir, { recursive: true });

  const random = createRandom(FIXTURE_SEED);

  let index = 0;
  for (const group of FIXTURE_LAYOUT) {
    const target = path.join(srcDir, group.dir);
    await fsp.mkdir(target, { recursive: true });
    for (let i = 0; i < group.count; i += 1) {
      const size = Math.floor(group.minSize + random() * Math.max(1, group.maxSize - group.minSize));
      const name = `file-${String(index).padStart(INDEX_PAD_WIDTH, '0')}-${size}B.bin`;
      const buffer = Buffer.alloc(size);
      for (let offset = 0; offset < size; offset += 1) buffer[offset] = Math.floor(random() * BYTE_VALUES);
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
// 手写最小 ZIP 记录（local header + central directory + EOCD）的实现见
// helpers/archive-fixtures.mjs 的 writeRawZip：M2 与 M4 的 zip-slip 用例共用同一份，
// 支持任意条目名与 unix 模式（../、绝对路径、symlink 样本都靠它造）。

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
  check('产物落在预期路径', await pathExists(archiveAbsPath), archiveUserPath);
  check('无残留 .part 半成品', !(await pathExists(`${archiveAbsPath}.part`)));

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
    const markerStates = await Promise.all(evil.markers.map((marker) => pathExists(marker)));
    const outsideClean = markerStates.every((exists) => !exists);
    const outDirClean = !(await pathExists(outDir)) || (await fsp.readdir(outDir)).length === 0;

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
  const benignOkExists = await pathExists(benignOkFile);
  check(
    '对照：合法原始 zip 能正常解压（防假阳性）',
    Boolean(benignTask && benignTask.status === 'done') && benignOkExists
      && (await fsp.readFile(benignOkFile, 'utf8')) === 'benign-raw-zip-ok',
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
  const logSizeBefore = await fileSizeOrZero(deleteLogPath);

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
  check('log-only：压缩包未被真删', await pathExists(archiveAbsPath), archiveUserPath);

  const logSizeAfter = await fileSizeOrZero(deleteLogPath);
  let logLines = [];
  if (await pathExists(deleteLogPath)) {
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

  const runSummary = reporter.summary({ withSkip: true });
  if (runSummary.fail > 0) process.exitCode = 1;
  await cleanupArtefacts();
}

/** 收尾清理测试产物（对齐 m4 做法）：/m2-test 整目录；设 ZIPCALM_M2_KEEP=1 可保留复核 */
async function cleanupArtefacts() {
  if (process.env.ZIPCALM_M2_KEEP === '1') {
    console.log('（ZIPCALM_M2_KEEP=1：保留测试产物便于人工复核）');
    return;
  }
  await fsp.rm(WORK, { recursive: true, force: true }).catch(() => {});
  console.log('    已清理测试产物：m2-test');
}

main().catch((error) => {
  console.error(`脚本异常：${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
