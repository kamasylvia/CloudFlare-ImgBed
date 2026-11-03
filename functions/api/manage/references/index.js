/**
 * GET /api/manage/references — 列出各引用源快照状态
 * (名称 / 最近上报时间 / URL 数 / 停滞天数)。fork-only,见 fork 仓库 issue #1。
 *
 * 停滞语义:某源长期未上报时其旧快照仍生效(不误判为孤儿),仅提示人工关注。
 */
import { getDatabase } from '../../../utils/databaseAdapter.js';
import { listSourceSnapshots } from '../../../utils/referenceRegistry.js';

export async function onRequest(context) {
    if (context.request.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'method not allowed, use GET' }), {
            status: 405,
            headers: { 'content-type': 'application/json', 'allow': 'GET' },
        });
    }
    const db = getDatabase(context.env);
    const sources = await listSourceSnapshots(db);
    return new Response(JSON.stringify({ sources }, null, 2), {
        headers: { 'content-type': 'application/json' },
    });
}
