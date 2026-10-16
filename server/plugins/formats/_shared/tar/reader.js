// tar 系列的**读取侧**：流式解析 + 条目读取辅助 + 错误映射
//
// 三种 tar 格式共用同一套解析（压缩层由 compression.js 负责解掉）。

import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import * as tar from 'tar';

import { ERROR_CODES, apiError } from '../../../../lib/errors.js';
import { openArchiveStream } from './compression.js';

/**
 * 流式解析归档：逐条目回调。
 *
 * **关键约束（实测踩过）**：`onentry` 里必须**同步**接管条目流（attach 消费者 / resume），
 * 只要延迟一个微任务，node-tar 就把该条目的数据丢掉（实测同一归档：同步读到 5/7 字节，延迟读到 0 字节）。
 * 因此回调本身不做 await，而是"同步启动消费并返回 Promise"，由这里统一收集等待。
 */
export async function parseArchive(archivePath, compression, onEntry) {
  const pending = [];
  const errors = [];
  const parser = tar.list({
    onentry: (entry) => {
      try {
        const result = onEntry(entry);
        if (result && typeof result.then === 'function') {
          pending.push(result.catch((error) => errors.push(error)));
        }
      } catch (error) {
        errors.push(error);
        entry.resume();
      }
    },
  });
  await pipeline(openArchiveStream(archivePath, compression), parser);
  await Promise.all(pending);
  if (errors.length > 0) throw errors[0];
}

/** 读条目内容（用于 test 的 read-all 校验） */
export function readEntryBuffer(entry) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    entry.on('data', (chunk) => chunks.push(chunk));
    entry.on('end', () => resolve(Buffer.concat(chunks)));
    entry.on('error', reject);
  });
}

/** node-tar 条目 → 契约里的条目形态（name/type/size/compressedSize） */
export function toApiEntry(entry) {
  const name = entry.path || entry.name || '';
  const isDir = entry.type === 'Directory';
  return {
    name,
    type: isDir ? 'dir' : 'file',
    size: Number(entry.size || 0),
    compressedSize: 0,
  };
}

/** 归档解析失败统一映射成契约错误码（不透传本机路径） */
export function mapArchiveError(error, archivePath) {
  if (error && error.code && String(error.code).startsWith('A')) return error; // 已是契约错误码
  const reason = (error && (error.code || error.message)) || 'parse-failed';
  if (reason === 'ENOENT') {
    return apiError(ERROR_CODES.PATH_NOT_FOUND, '压缩包不存在', { archive: path.basename(archivePath) });
  }
  return apiError(ERROR_CODES.ARCHIVE_CORRUPTED, '压缩包无法解析（可能已损坏）', {
    archive: path.basename(archivePath),
    reason,
  });
}
