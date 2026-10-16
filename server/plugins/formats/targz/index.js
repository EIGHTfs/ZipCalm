// tar.gz 格式包（node-tar + Node 内置 node:zlib 的 gzip）
//
// 复合扩展名 `.tar.gz` 是**一个整体**（另有别名 `.tgz`）：注册表按"最长复合扩展名优先"匹配，
// 保证 `x.tar.gz` 命中本格式而不是被 `.gz` 抢走（契约 §3.1）。

import { createTarPlugin } from '../_shared/tarFamily.js';

export default createTarPlugin({
  id: 'targz',
  name: 'TAR.GZ',
  ext: '.tar.gz',
  extAliases: ['.tgz'],
  mime: 'application/gzip',
  compression: 'gzip',
  levelRange: [0, 9],
  defaultLevel: 6,
});
