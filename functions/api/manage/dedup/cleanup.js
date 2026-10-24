/**
 * 存量文件内容去重（一键清理）
 *
 * POST /api/manage/dedup/cleanup[?dryRun=true]
 *
 * 遍历全部文件记录，经本地 /file/<id> 路由读取内容计算 SHA-256，按内容分组；
 * 每组保留 timestamp 最早的一条，其余通过官方 manage/delete 接口删除
 * （透传当前请求的鉴权头，完整复用渠道删除逻辑），并为保留项回写去重索引
 * dedup:<hash>，使后续上传直接命中秒传。
 *
 * 需要管理员权限（manage 中间件）。?dryRun=true 时只返回报告不执行删除。
 */
import { getDatabase } from '../../../utils/databaseAdapter.js';

export async function onRequest(context) {
    if (context.request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'method not allowed, use POST' }), {
            status: 405,
            headers: { 'content-type': 'application/json' },
        });
    }

    const { request, env } = context;
    const url = new URL(request.url);
    const dryRun = url.searchParams.get('dryRun') === 'true';
    const origin = url.origin;

    const db = getDatabase(env);
    const files = await db.prepare(
        'SELECT id, file_name, channel, timestamp FROM files ORDER BY timestamp ASC'
    ).all().then(r => r.results || []);

    // 按内容分组
    const groups = new Map(); // sha256 -> [{ id, file_name, timestamp }]
    let readErrors = 0;
    for (const file of files) {
        try {
            const resp = await fetch(`${origin}/file/${file.id}`);
            if (!resp.ok) {
                readErrors++;
                continue;
            }
            const digest = await crypto.subtle.digest('SHA-256', await resp.arrayBuffer());
            const hash = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
            if (!groups.has(hash)) groups.set(hash, []);
            groups.get(hash).push({ id: file.id, name: file.file_name, timestamp: file.timestamp });
        } catch (err) {
            console.error(`dedup cleanup: failed to read ${file.id}:`, err);
            readErrors++;
        }
    }

    const report = {
        scanned: files.length,
        readErrors,
        duplicateGroups: 0,
        deleted: [],
        kept: [],
        dryRun,
    };

    for (const [hash, entries] of groups) {
        if (entries.length < 2) continue;
        report.duplicateGroups++;
        const keep = entries[0]; // 已按 timestamp 升序，最早者保留
        report.kept.push({ id: keep.id, name: keep.name, link: `/file/${keep.id}` });

        // 回填去重索引：保留项命中后，后续同内容上传直接秒传到该链接
        try {
            await db.put(`dedup:${hash}`, keep.id);
        } catch (err) {
            console.error('dedup cleanup: failed to write dedup index:', err);
        }

        if (dryRun) continue;

        for (const dup of entries.slice(1)) {
            try {
                const delResp = await fetch(`${origin}/api/manage/delete/${dup.id}`, {
                    method: 'DELETE',
                    headers: request.headers, // 透传鉴权
                });
                if (delResp.ok) {
                    report.deleted.push({ id: dup.id, name: dup.name });
                } else {
                    report.deleted.push({ id: dup.id, name: dup.name, error: `HTTP ${delResp.status}` });
                }
            } catch (err) {
                report.deleted.push({ id: dup.id, name: dup.name, error: String(err.message || err) });
            }
        }
    }

    return new Response(JSON.stringify(report, null, 2), {
        headers: { 'content-type': 'application/json' },
    });
}
