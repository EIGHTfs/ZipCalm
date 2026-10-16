// 运行期环境自检（M4 起的最低版本约束）
//
// 为什么要有：`.tar.zst` 依赖 Node ≥ 22.15 内置的 zstd（`node:zlib` 的 `createZstdCompress`）。
// 版本不够时**必须在启动时就明确拒绝**，而不是等用户点了压缩才在半个任务里炸 ——
// 也就是说：把"环境不满足"变成启动期的一次性、可读的失败，而不是运行期的随机失败。
//
// 设计成纯函数（可注入 version）便于单测模拟低版本。

/** 最低版本要求与理由（版本一升，这里同步改，单一事实源） */
export const MIN_NODE = { major: 22, minor: 15, reason: 'zstd 内置 API（node:zlib 的 createZstdCompress）自 v22.15.0 起提供，.tar.zst 依赖它' };

/** 解析 "22.23.3" / "v22.23.3" → {major, minor, patch} */
export function parseNodeVersion(version) {
  const text = String(version || '').replace(/^v/, '');
  const [major, minor, patch] = text.split('.').map((part) => Number.parseInt(part, 10));
  return {
    major: Number.isInteger(major) ? major : 0,
    minor: Number.isInteger(minor) ? minor : 0,
    patch: Number.isInteger(patch) ? patch : 0,
  };
}

/**
 * 版本检查（不抛错，返回结果供启动流程决定怎么报告）
 * @param {{major: number, minor: number, reason: string}} [min]
 * @param {string} [version]
 */
export function checkNodeVersion(min = MIN_NODE, version = process.versions.node) {
  const current = parseNodeVersion(version);
  const ok = current.major > min.major || (current.major === min.major && current.minor >= min.minor);
  return {
    ok,
    required: `${min.major}.${min.minor}.0`,
    current: String(version || '').replace(/^v/, ''),
    reason: min.reason,
    message: ok
      ? `Node 版本自检通过：v${String(version || '').replace(/^v/, '')} ≥ v${min.major}.${min.minor}.0`
      : `Node 版本过低：本服务要求 **v${min.major}.${min.minor}.0 及以上**，当前是 v${String(version || '').replace(/^v/, '')}。\n`
        + `原因：${min.reason}\n`
        + '建议：升级 Node 到 22.15+（NAS 上可用套件管理器升级，或改用能提供 zstd 的运行环境）后重试。',
  };
}

/** 版本不满足就抛错（启动流程捕获后打印并退出） */
export function assertNodeVersion(min = MIN_NODE, version = process.versions.node) {
  const result = checkNodeVersion(min, version);
  if (!result.ok) throw new Error(result.message);
  return result;
}
