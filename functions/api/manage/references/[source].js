/**
 * POST /api/manage/references/{source} — 上报某源的全量引用快照(幂等,全量覆盖)
 * DELETE /api/manage/references/{source} — 注销该源(快照删除,不再参与孤儿并集)
 *
 * 快照体:{ updatedAt?: number, urls: string[] }。urls 为该源文档中引用的图床
 * 链接全量集合(完整 URL 或 /file/ 相对路径均可),服务端归一化为 file id 后存储。
 * fork-only,见 fork 仓库 issue #1。
 */
import { getDatabase } from '../../../utils/databaseAdapter.js';
import {
    SOURCE_NAME_RE,
    normalizeSnapshotUrls,
    saveSourceSnapshot,
    deleteSourceSnapshot,
    readSourcesRegistry,
} from '../../../utils/referenceRegistry.js';

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    // Pages Functions 将 [source] 捕获放进 params;context.params 可能未展开,兜底从路径解析
    let source = context.params?.source;
    if (!source) {
        const m = url.pathname.match(/\/api\/manage\/references\/([^/]+)$/);
        source = m ? m[1] : '';
    }
    source = decodeURIComponent(source || '');

    if (!SOURCE_NAME_RE.test(source)) {
        return new Response(JSON.stringify({ error: 'invalid source name; use [a-zA-Z0-9][a-zA-Z0-9_-]{0,63}' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
        });
    }

    const db = getDatabase(env);

    if (request.method === 'POST') {
        let body;
        try {
            body = await request.json();
        } catch (err) {
            return new Response(JSON.stringify({ error: 'request body must be JSON' }), {
                status: 400,
                headers: { 'content-type': 'application/json' },
            });
        }
        const normalized = normalizeSnapshotUrls(body?.urls);
        if (normalized.error) {
            return new Response(JSON.stringify({ error: normalized.error }), {
                status: 400,
                headers: { 'content-type': 'application/json' },
            });
        }
        const result = await saveSourceSnapshot(db, source, normalized.ids, {
            skipped: normalized.skipped,
            reportedAt: body?.updatedAt,
        });
        return new Response(JSON.stringify({
            source,
            updatedAt: result.updatedAt,
            stored: result.count,
            received: Array.isArray(body?.urls) ? body.urls.length : 0,
            skipped: result.skipped,
        }, null, 2), {
            headers: { 'content-type': 'application/json' },
        });
    }

    if (request.method === 'DELETE') {
        const existed = await deleteSourceSnapshot(db, source);
        const registry = await readSourcesRegistry(db);
        return new Response(JSON.stringify({ source, existed, sources: Object.keys(registry.sources) }), {
            headers: { 'content-type': 'application/json' },
        });
    }

    return new Response(JSON.stringify({ error: 'method not allowed, use POST or DELETE' }), {
        status: 405,
        headers: { 'content-type': 'application/json', 'allow': 'POST, DELETE' },
    });
}
