// 任务服务端动作（从 stores/tasks.js 拆出）：详情/历史/取消/重试/确认删除/删除记录
//
// 共同点：都是"打一个 API 再把结果回填集合状态"，所以只依赖 collection，不关心传输层。
// 回填统一走 collection.upsert，避免各动作各写一套合并逻辑。

import { api } from '../../api/client.js';

/**
 * @param {{collection: ReturnType<typeof import('./collection.js').createTaskCollection>}} deps
 */
export function createTaskActions({ collection }) {
  /** 详情：从服务端拉完整任务（含 result/delete 明细）并回填 store */
  async function loadDetail(id) {
    const payload = await api.get(`/tasks/${id}`);
    collection.upsert(payload.task);
    return payload.task;
  }

  async function loadHistory(limit = 50) {
    const payload = await api.get('/tasks/history', { limit });
    collection.history.value = payload.items || [];
    return collection.history.value;
  }

  async function cancel(id) {
    const payload = await api.post(`/tasks/${id}/cancel`, {});
    collection.upsert(payload.task);
    return payload.task;
  }

  async function retry(id) {
    const payload = await api.post(`/tasks/${id}/retry`, {});
    collection.upsert(payload.task);
    return payload.task;
  }

  async function confirmDelete(id, expectedFiles) {
    const payload = await api.post(`/tasks/${id}/confirm-delete`, { confirm: true, expectedFiles });
    collection.upsert(payload.task);
    return payload.task;
  }

  /** 删除活动记录（仅终态；后端会拒绝非终态）。删除后本地立即移除，再拉一次历史保持一致 */
  async function remove(id) {
    const result = await api.del(`/tasks/${id}`);
    collection.removeLocal(id);
    // loadHistory 自带默认页大小（不重复写 50，避免两处默认值漂移）
    await loadHistory().catch(() => {});
    return result;
  }

  return { loadDetail, loadHistory, cancel, retry, confirmDelete, remove };
}
