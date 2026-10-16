// 路径工具（前端只做展示层拼接；**不做安全校验**）
//
// 安全边界：路径是否越界由服务端 core/fs/safePath.js 判定（INV-06）。
// 前端这里的职责只有两个：拼面包屑、算上级路径 —— 都是纯字符串操作。

/**
 * 规范化：保证以 / 开头、无重复斜杠、无结尾斜杠（根除外）。
 * @param {string} input
 * @returns {string}
 */
export function normalizePath(input) {
  const raw = typeof input === 'string' && input.length > 0 ? input : '/';
  const segments = raw.split('/').filter((segment) => segment !== '' && segment !== '.');
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

/**
 * 上级路径；根目录返回 null（用于"返回上级"按钮置灰）。
 * @param {string} input
 * @returns {string|null}
 */
export function parentPath(input) {
  const normalized = normalizePath(input);
  if (normalized === '/') return null;
  const segments = normalized.split('/').filter(Boolean);
  segments.pop();
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

/**
 * 面包屑：`/a/b` → [{label:'根目录',path:'/'},{label:'a',path:'/a'},{label:'b',path:'/a/b'}]
 * @param {string} input
 */
export function breadcrumbsOf(input) {
  const normalized = normalizePath(input);
  const items = [{ label: '根目录', path: '/' }];
  const segments = normalized.split('/').filter(Boolean);
  let accumulated = '';
  for (const segment of segments) {
    accumulated += `/${segment}`;
    items.push({ label: segment, path: accumulated });
  }
  return items;
}

/** 拼接子项路径（列表项 path 由服务端给出，这里仅作为兜底/参考） */
export function joinPath(base, name) {
  const normalized = normalizePath(base);
  return normalized === '/' ? `/${name}` : `${normalized}/${name}`;
}
