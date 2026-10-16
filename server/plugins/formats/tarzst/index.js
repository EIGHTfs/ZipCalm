// tar.zst 格式包（node-tar + zstd）
//
// zstd 能力**自探测 + 回退链**（docs/02 §二）：
//   ① Node ≥ 22.15 内置 `node:zlib` 的 `createZstdCompress`（零依赖、流式、跨平台）—— 首选；
//   ② 系统 `zstd` 命令（`ZC_ZSTD_BIN` 可覆盖路径）；
//   ③ 都不可用 → `available() = false` 并给出明确原因（前端据此置灰，不静默降级、不假装可用）。
//
// 排障用开关：`ZIPCALM_DISABLE_BUILTIN_ZSTD=1` 强制禁用内置实现，用于验证回退链是否真的生效。

import { createTarPlugin } from '../_shared/tarFamily.js';

export default createTarPlugin({
  id: 'tarzst',
  name: 'TAR.ZST',
  ext: '.tar.zst',
  extAliases: ['.tzst'],
  mime: 'application/zstd',
  compression: 'zstd',
  levelRange: [1, 19],
  defaultLevel: 3,
});
