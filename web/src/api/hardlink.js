// 硬链接去重 API（docs/15 §三）：scan（只读）+ execute（显式确认）。
// 网络出口统一走 api/client.js（响应拦截器已解包 `{ok,data,error}` 信封，
// 这里拿到的直接是业务数据），本文件不重复处理。

import api from './client.js';

/**
 * 扫描重复分组（服务端只读，永不改文件）。
 * @param {{path: string, extensions: string[]}} payload
 * @returns {Promise<{path, extensions, groups: Array, stats: Object}>}
 */
export async function scanHardlinkDuplicates(payload) {
  return api.post('/hardlink/scan', payload);
}

/**
 * 执行硬链接替换（需显式 confirmed=true；服务端会重新全量哈希复核）。
 * @param {{path: string, extensions: string[], groups: Array, confirmed: true}} payload
 * @returns {Promise<{executed: number, savedBytes: number, failed: Array, skippedGroups: Array}>}
 */
export async function executeHardlinkGroups(payload) {
  return api.post('/hardlink/execute', payload);
}
