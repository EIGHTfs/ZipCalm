// RAR 的 js 引擎执行器（**子进程**，每次操作一个独立进程）
//
// 为什么必须子进程（不能像最初那样在服务进程里直接调）：
//   1) `node-unrar-js` 的 `extract()` 是**同步**的（返回 ArcFiles，不是 Promise）。在服务进程里直接调
//      = 解压期间 Node 事件循环停摆 → SSE 不推进度、全站 HTTP 无响应、任务取消按钮点不动。
//   2) WASM 内存占在服务进程里（7z 那边峰值 460MB 在子进程），且 WASM 崩溃会**带走整个服务**。
//   3) 同步执行无法取消；子进程 + SIGKILL 是唯一可靠的超时/取消手段。
//
// 协议（父进程 ↔ 本脚本）：
//   入参：argv[2] = JSON spec
//     { op: 'list'|'extract'|'test', archivePath, targetPath?, password? }
//   出参：stdout **只打印一行 JSON** 结果信封；诊断/异常文本走 stderr。
//     成功：{"ok":true, ...}
//     失败：{"ok":false,"errorCode":"MISSING_PASSWORD|BAD_PASSWORD|ARCHIVE_CORRUPTED","message":"…"}

import { createRequire } from 'node:module';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const spec = JSON.parse(process.argv[2] || '{}');

/** 结果信封只走 stdout 一行，父进程按最后一行 JSON 解析 */
function emitEnvelope(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** js 侧异常 → 契约错误码（与原生 unrar 的三态口径保持一致） */
function classify(error) {
  const reason = String((error && (error.reason || error.message)) || '');
  if (/MISSING_PASSWORD/i.test(reason)) return { errorCode: 'MISSING_PASSWORD', message: '该压缩包已加密，请输入密码' };
  if (/BAD_PASSWORD|WRONG_PASSWORD/i.test(reason)) {
    return spec.password
      ? { errorCode: 'BAD_PASSWORD', message: '密码错误' }
      : { errorCode: 'MISSING_PASSWORD', message: '该压缩包已加密，请输入密码' };
  }
  return { errorCode: 'ARCHIVE_CORRUPTED', message: '压缩包损坏', reason: reason.slice(0, 80) };
}

function headerList(extractor) {
  const listed = extractor.getFileList();
  const container = Array.isArray(listed) ? listed[0] : listed;
  return Array.from((container && container.fileHeaders) || []);
}

function toEntry(header) {
  const name = String(header.name || '').replace(/\\/g, '/');
  const isDir = Boolean(header.flags && header.flags.directory) || name.endsWith('/');
  return {
    name,
    type: isDir ? 'dir' : 'file',
    size: isDir ? 0 : Number(header.unpSize || 0),
    compressedSize: Number(header.packSize || 0),
    encrypted: Boolean(header.flags && header.flags.encrypted),
  };
}

async function walkFiles(dirAbs, prefix = '') {
  const out = [];
  for (const dirent of await fsp.readdir(dirAbs, { withFileTypes: true }).catch(() => [])) {
    const relative = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      out.push(...await walkFiles(path.join(dirAbs, dirent.name), relative));
      continue;
    }
    const stat = await fsp.lstat(path.join(dirAbs, dirent.name)).catch(() => null);
    out.push({ name: relative, size: stat ? stat.size : 0 });
  }
  return out;
}

async function main() {
  const lib = createRequire(import.meta.url)('node-unrar-js');

  if (spec.op === 'list') {
    const extractor = await lib.createExtractorFromFile({ filepath: spec.archivePath });
    const entries = headerList(extractor).map(toEntry);
    emitEnvelope({ ok: true, entries, encrypted: entries.some((entry) => entry.encrypted) });
    return;
  }

  // extract / test 都要真正解一遍（js 没有独立的 test API）
  const targetDir = spec.targetPath || (await fsp.mkdtemp(path.join(os.tmpdir(), 'zc-rarjs-')));
  const ownTemp = !spec.targetPath;
  try {
    await fsp.mkdir(targetDir, { recursive: true });
    const extractor = await lib.createExtractorFromFile({
      filepath: spec.archivePath,
      targetPath: targetDir,
      ...(spec.password ? { password: spec.password } : {}),
    });
    const expected = headerList(extractor).map(toEntry).filter((entry) => entry.type === 'file');

    // 关键：`files` 是**惰性迭代**，必须消费才会真正写盘（只调 extract() 不迭代 = 目标目录为空）
    const result = extractor.extract();
    let consumed = 0;
    for (const item of result.files || []) {
      if (item && item.fileHeader) consumed += 1;
    }

    const actual = await walkFiles(targetDir);
    const actualBytes = actual.reduce((sum, item) => sum + item.size, 0);
    const expectedBytes = expected.reduce((sum, item) => sum + item.size, 0);

    // 损坏包在 js 侧不报错（静默少文件）：用「条数/字节数 vs 清单」兜底。
    // 注意：清单本身被截断时这条也抓不到（已知限制，已记 docs/17 D-11）。
    if (expected.length > 0 && (actual.length < expected.length || actualBytes < expectedBytes)) {
      emitEnvelope({
        ok: false,
        errorCode: 'ARCHIVE_CORRUPTED',
        message: '压缩包损坏',
        expectedFiles: expected.length,
        actualFiles: actual.length,
      });
      return;
    }

    emitEnvelope({ ok: true, fileCount: actual.length, bytesOut: actualBytes, consumed, targetDir });
  } finally {
    if (ownTemp) await fsp.rm(targetDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  const classified = classify(error);
  process.stderr.write(`[rar-js-runner] ${(error && (error.reason || error.message)) || 'failed'}\n`);
  emitEnvelope({ ok: false, ...classified });
  process.exitCode = 0;
});
