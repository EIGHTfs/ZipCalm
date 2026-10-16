// tar 格式包（不压缩的裸 tar，node-tar）
//
// 归档层与 .tar.gz / .tar.zst 共用同一个工厂（`_shared/tarFamily.js`）：
// zip-slip 判定、进度、流式写入只有一份实现，三种格式的差别只在压缩层。
// 契约：docs/M0/插件契约.md §3.4 create / §3.4.1 extract / §3.5 list / §3.6 test

import { createTarPlugin } from '../_shared/tarFamily.js';

export default createTarPlugin({
  id: 'tar',
  name: 'TAR',
  ext: '.tar',
  extAliases: [],
  mime: 'application/x-tar',
  compression: 'none',
  // 不压缩：不支持 level（契约里 levelRange 省略即表示不支持）
});
