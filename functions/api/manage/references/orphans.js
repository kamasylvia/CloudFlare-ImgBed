/**
 * GET /api/manage/references/orphans — 孤儿文件报告(只读)
 * 孤儿 = 文件索引内有记录、但不在任何源引用快照并集中的文件。
 * 纯元数据差集,不读文件字节;Workers(KV/D1)与自建部署均可运行。
 *
 * 语义:
 * - 某源长期未上报时其旧快照仍生效(不误判为孤儿),响应的 sources 里带 staleDays 供提示;
 * - 与 dedup scan 相同的完整性纪律:分片缺失/损坏、扫描期间索引变化、超时都标记 complete:false;
 * - 不删除任何文件;清理由管理员人工执行。
 *
 * fork-only,见 fork 仓库 issue #1(上游 issue #771 作者决定不进主仓库)。
 */
import { getDatabase } from '../../../utils/databaseAdapter.js';
import {
    listSourceSnapshots,
    loadReferencedIdSets,
    readIndexEntries,
} from '../../../utils/referenceRegistry.js';

export async function onRequest(context) {
    if (context.request.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'method not allowed, use GET' }), {
            status: 405,
            headers: { 'content-type': 'application/json', 'allow': 'GET' },
        });
    }

    const { request, env } = context;
    const url = new URL(request.url);
    const parsedLimit = parseInt(url.searchParams.get('limit') || '1000', 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit >= 1 ? Math.min(parsedLimit, 10000) : 1000;
    // 总时间预算:纯元数据操作通常远小于 30s;参数只允许调低,语义与 dedup scan 一致
    const parsedTimeout = parseInt(url.searchParams.get('timeoutMs') || '30000', 10);
    const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout >= 0 ? Math.min(parsedTimeout, 30000) : 30000;
    const deadline = Date.now() + timeoutMs;
    let timedOut = false;

    const db = getDatabase(env);
    const sources = await listSourceSnapshots(db, { now: Date.now() });
    if (sources.length === 0) {
        // 保守语义:尚无任何源上报时无法区分「确实无引用」与「尚未登记」,
        // 报告为空而不是把全部文件判成孤儿;前端提示先接入客户端上报。
        return new Response(JSON.stringify({
            complete: true,
            timedOut: false,
            indexChanged: false,
            chunkErrors: [],
            recordErrors: [],
            sources: [],
            totalFiles: 0,
            referencedCount: 0,
            orphanCount: 0,
            omitted: 0,
            orphans: [],
            noSources: true,
            scannedAt: new Date().toISOString(),
        }, null, 2), {
            headers: { 'content-type': 'application/json' },
        });
    }
    const { perSource, union } = await loadReferencedIdSets(db, sources.map(s => s.name), deadline);
    if (deadline && Date.now() >= deadline) timedOut = true;

    const { entries, chunkErrors, metaStr } = await readIndexEntries(db, deadline);
    if (deadline && Date.now() >= deadline) timedOut = true;

    // 逐条取权威元数据;不在并集中的即孤儿
    const orphans = [];
    const recordErrors = [];
    let totalFiles = 0;
    let referencedCount = 0;
    for (const entry of entries) {
        if (Date.now() >= deadline) { timedOut = true; break; }
        if (typeof entry?.id !== 'string' || !entry.id) {
            recordErrors.push({ id: entry?.id ?? null, error: 'invalid index entry' });
            continue;
        }
        totalFiles++;
        if (union.has(entry.id)) { referencedCount++; continue; }
        try {
            const rec = await db.getWithMetadata(entry.id);
            const meta = rec?.metadata || entry.metadata || {};
            orphans.push({
                id: entry.id,
                name: meta.FileName || entry.id,
                channel: meta.ChannelName || meta.Channel || '',
                timestamp: meta.TimeStamp ?? null,
            });
        } catch (err) {
            recordErrors.push({ id: entry.id, error: String(err?.message || err) });
        }
    }

    // 扫描只读取索引快照;期间索引变化须标记不完整(与 dedup scan 一致)
    let indexChanged = false;
    if (!timedOut) {
        try {
            const pending = await db.list({ prefix: 'manage@index@operation_', limit: 1 });
            const currentMeta = await db.get('manage@index@meta');
            indexChanged = pending.keys.length > 0 || currentMeta !== metaStr;
        } catch (err) {
            chunkErrors.push({ chunk: 'meta', error: String(err?.message || err) });
        }
    }

    orphans.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    const omitted = orphans.length > limit ? orphans.length - limit : 0;
    const reported = omitted > 0 ? orphans.slice(0, limit) : orphans;

    const complete = !timedOut && !indexChanged
        && chunkErrors.length === 0
        && recordErrors.length === 0;

    return new Response(JSON.stringify({
        complete,
        timedOut,
        indexChanged,
        chunkErrors,
        recordErrors,
        sources,
        totalFiles,
        referencedCount,
        orphanCount: orphans.length,
        omitted,
        orphans: reported,
        scannedAt: new Date().toISOString(),
    }, null, 2), {
        headers: { 'content-type': 'application/json' },
    });
}
