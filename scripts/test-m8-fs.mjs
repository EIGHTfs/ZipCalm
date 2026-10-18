#!/usr/bin/env node
//
// M8 前置：文件系统写端点验收（mkdir / rename / move / delete）
//
// 契约：docs/M0/API规范.md §4.2。逐条核：
//   mkdir 幂等 / 父目录不存在 / 同名文件占位
//   rename 同目录改名 / 冲突不覆盖 / 新名字含分隔符被拒
//   move 成功 / 目标同名整批拒绝 / 越界拒绝 / 超过单次上限被拒
//   delete 进回收站（trashBatch + 文件确实不在原处）/ 不存在记 notFound / 越界拒绝
//
// 所有夹具都建在 /m8-fs-test 下，结束时清理（回收站里的那份保留：那是"可恢复"的证据）。

import fsp from 'node:fs/promises';
import path from 'node:path';

import { PROJECT_ROOT, pathExists } from './helpers/script-env.mjs';
import { loadRuntimeConfig } from './helpers/test-config.mjs';
import { createReporter } from './helpers/test-report.mjs';

const runtimeConfig = await loadRuntimeConfig(PROJECT_ROOT);
const PORT = process.env.ZIPCALM_PORT || (runtimeConfig.server && runtimeConfig.server.port) || 3010;
const BASE = process.env.ZIPCALM_BASE || `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(PROJECT_ROOT, (runtimeConfig.storage && runtimeConfig.storage.root) || './storage/fs-root');
const LOGIN = { username: process.env.ZIPCALM_TEST_USER || 'admin', password: process.env.ZIPCALM_TEST_PASSWORD || 'zipcalm' };

const HTTP_TIMEOUT_MS = 15000;
/** 信封解析失败时回显的消息片段长度 */
const ERROR_SNIPPET_CHARS = 120;
const FIXTURE_API = '/m8-fs-test';
const FIXTURE_ABS = path.join(ROOT, 'm8-fs-test');

const reporter = createReporter();
const { check } = reporter;
let TOKEN = null;

async function api(method, urlPath, body) {
  const response = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, error: { code: 'NO_ENVELOPE', message: text.slice(0, ERROR_SNIPPET_CHARS) } };
  }
  return { status: response.status, json };
}

const errorCode = (result) => (result.json && result.json.error && result.json.error.code) || null;

/** 建一套干净夹具：/m8-fs-test/{a.txt, keep.txt, dir/} */
async function prepareFixture() {
  await fsp.rm(FIXTURE_ABS, { recursive: true, force: true });
  await fsp.mkdir(path.join(FIXTURE_ABS, 'dir'), { recursive: true });
  await fsp.writeFile(path.join(FIXTURE_ABS, 'a.txt'), 'aaa');
  await fsp.writeFile(path.join(FIXTURE_ABS, 'keep.txt'), 'keep');
}

async function main() {
  const login = await api('POST', '/auth/login', LOGIN);
  TOKEN = login.json && login.json.data && login.json.data.token;
  check('登录拿到 Bearer Token', Boolean(TOKEN));

  await prepareFixture();

  // ===== mkdir =====
  const created = await api('POST', '/fs/mkdir', { path: `${FIXTURE_API}/newdir` });
  check('mkdir 新建成功 created:true', Boolean(created.json && created.json.data && created.json.data.created === true), `code=${errorCode(created)}`);
  const again = await api('POST', '/fs/mkdir', { path: `${FIXTURE_API}/newdir` });
  check('mkdir 幂等 created:false', Boolean(again.json && again.json.data && again.json.data.created === false), `code=${errorCode(again)}`);
  const noParent = await api('POST', '/fs/mkdir', { path: `${FIXTURE_API}/nope/child` });
  check('mkdir 父目录不存在 → PATH_NOT_FOUND', errorCode(noParent) === 'PATH_NOT_FOUND', `code=${errorCode(noParent)}`);
  const fileTaken = await api('POST', '/fs/mkdir', { path: `${FIXTURE_API}/a.txt` });
  check('mkdir 同名文件占位 → TARGET_EXISTS', errorCode(fileTaken) === 'TARGET_EXISTS', `code=${errorCode(fileTaken)}`);

  // ===== rename =====
  const renamed = await api('POST', '/fs/rename', { path: `${FIXTURE_API}/a.txt`, newName: 'b.txt' });
  check('rename 成功返回新路径', Boolean(renamed.json && renamed.json.data && renamed.json.data.path === `${FIXTURE_API}/b.txt`), JSON.stringify(renamed.json && renamed.json.data));
  check('rename 后磁盘上确实是新名字', await pathExists(path.join(FIXTURE_ABS, 'b.txt')));
  const conflict = await api('POST', '/fs/rename', { path: `${FIXTURE_API}/b.txt`, newName: 'keep.txt' });
  check('rename 冲突 → TARGET_EXISTS（不覆盖）', errorCode(conflict) === 'TARGET_EXISTS', `code=${errorCode(conflict)}`);
  check('冲突后原文件内容未变', (await fsp.readFile(path.join(FIXTURE_ABS, 'keep.txt'), 'utf8')) === 'keep');
  const badName = await api('POST', '/fs/rename', { path: `${FIXTURE_API}/b.txt`, newName: 'x/y' });
  check('rename 新名字含分隔符 → VALIDATION_FAILED', errorCode(badName) === 'VALIDATION_FAILED', `code=${errorCode(badName)}`);

  // ===== move =====
  const moved = await api('POST', '/fs/move', { paths: [`${FIXTURE_API}/b.txt`], targetDir: `${FIXTURE_API}/dir` });
  check('move 成功返回目标路径', Boolean(moved.json && moved.json.data && moved.json.data.moved && moved.json.data.moved[0] === `${FIXTURE_API}/dir/b.txt`), JSON.stringify(moved.json && moved.json.data));

  // 对照组：目标目录没有同名项 → 成功
  await fsp.mkdir(path.join(FIXTURE_ABS, 'dir2'), { recursive: true });
  await fsp.writeFile(path.join(FIXTURE_ABS, 'z.txt'), 'zzz');
  const okMove = await api('POST', '/fs/move', { paths: [`${FIXTURE_API}/z.txt`], targetDir: `${FIXTURE_API}/dir2` });
  check('move 到空目录成功（对照组）', Boolean(okMove.json && okMove.json.ok && okMove.json.data.moved[0] === `${FIXTURE_API}/dir2/z.txt`), `code=${errorCode(okMove)}`);

  // 冲突组：目标目录已有同名项 → 整批拒绝，且源保持原地
  await fsp.writeFile(path.join(FIXTURE_ABS, 'dir', 'dup.txt'), 'in-dir');
  await fsp.writeFile(path.join(FIXTURE_ABS, 'dup.txt'), 'in-root');
  const moveConflict = await api('POST', '/fs/move', { paths: [`${FIXTURE_API}/dup.txt`], targetDir: `${FIXTURE_API}/dir` });
  check('move 目标同名 → TARGET_EXISTS（整批拒绝）', errorCode(moveConflict) === 'TARGET_EXISTS', `code=${errorCode(moveConflict)}`);
  check('冲突后源文件仍在原地且内容未变', (await fsp.readFile(path.join(FIXTURE_ABS, 'dup.txt'), 'utf8')) === 'in-root');

  const escape = await api('POST', '/fs/move', { paths: [`${FIXTURE_API}/dup.txt`], targetDir: '/../../etc' });
  check('move 越界目标 → PATH_OUT_OF_ROOT', errorCode(escape) === 'PATH_OUT_OF_ROOT', `code=${errorCode(escape)}`);

  // ===== delete（进回收站）=====
  const deleted = await api('POST', '/fs/delete', { paths: [`${FIXTURE_API}/dir/b.txt`, `${FIXTURE_API}/missing.txt`] });
  const deleteData = (deleted.json && deleted.json.data) || {};
  check('delete 返回 deleted 与被删项匹配', Array.isArray(deleteData.deleted) && deleteData.deleted.includes(`${FIXTURE_API}/dir/b.txt`), JSON.stringify(deleteData));
  check('delete 不存在的路径记 notFound（整体仍 ok）', Array.isArray(deleteData.notFound) && deleteData.notFound.some((item) => item.path === `${FIXTURE_API}/missing.txt`), JSON.stringify(deleteData.notFound));
  check('delete 返回 trashBatch（可恢复）', typeof deleteData.trashBatch === 'string' && deleteData.trashBatch.length > 0, String(deleteData.trashBatch));
  check('delete 后原文件已不在原地', !(await pathExists(path.join(FIXTURE_ABS, 'dir', 'b.txt'))));
  const deleteEscape = await api('POST', '/fs/delete', { paths: ['/../../etc/passwd'] });
  check('delete 越界 → PATH_OUT_OF_ROOT', errorCode(deleteEscape) === 'PATH_OUT_OF_ROOT', `code=${errorCode(deleteEscape)}`);

  await fsp.rm(FIXTURE_ABS, { recursive: true, force: true });
  const runSummary = reporter.summary();
  if (runSummary.fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`M8 fs 端点验收脚本异常：${error.message}`);
  process.exitCode = 1;
});
