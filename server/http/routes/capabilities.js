// 能力元数据端点（docs/19 §三：前端不硬编码能力列表，运行时从 API 拉取）
//
// GET /capabilities/:id —— 返回能力元数据（name/appliesTo/methods 含 caveat），
// 绝不包含任何密码值（PW-1）。id 必须在已知能力白名单内（shared/capabilities.js）。

import { ERROR_CODES, apiError } from '../../lib/errors.js';
import { CAPABILITY_IDS } from '../../../shared/capabilities.js';

export default async function capabilityRoutes(app) {
  app.get('/capabilities/:id', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const { id } = request.params;
    if (!CAPABILITY_IDS.includes(id)) {
      throw apiError(ERROR_CODES.PATH_NOT_FOUND, `未知能力：${String(id)}`);
    }
    const cap = app.m2.capRegistry && app.m2.capRegistry.get(id);
    if (!cap || typeof cap.describe !== 'function') {
      throw apiError(ERROR_CODES.PATH_NOT_FOUND, `能力 ${id} 未加载`);
    }
    reply.ok(cap.describe());
  });
}
