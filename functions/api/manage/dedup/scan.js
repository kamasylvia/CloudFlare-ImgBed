/**
 * 存量重复文件扫描(只读)
 *
 * POST /api/manage/dedup/scan
 *
 * 遍历文件索引,经本地 /file/<id> 路由读取内容计算 SHA-256,按内容分组。
 * 仅扫描与展示,不做任何删除或链接改写;结果由管理员人工判断处理。
 *
 * 依赖本地 HTTP 回环读取与 Node.js 运行时(crypto.subtle + fetch 到自身),
 * 仅支持 Docker / Node.js 服务端部署;Workers / Pages 不支持(前端需根据
 * 部署形态隐藏入口,后端也会在非 Node 环境返回 501)。
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

    // 仅 Docker / Node.js 服务端部署支持:Workers/Pages 无本地回环自读能力
    const isNodeRuntime = typeof env.img_d1 !== 'undefined' && env.img_d1 !== null;
    if (!isNodeRuntime) {
        return new Response(JSON.stringify({
            error: 'duplicate scan is only available on Docker / Node.js server deployments',
            supported: false,
        }), {
            status: 501,
            headers: { 'content-type': 'application/json' },
        });
    }

    const db = getDatabase(env);
    const origin = url.origin;

    // 从分片索引读取全部文件记录
    const INDEX_META_KEY = 'manage@index@meta';
    const INDEX_KEY = 'manage@index';
    const metaStr = await db.get(INDEX_META_KEY);
    const meta = metaStr ? JSON.parse(metaStr) : { chunkCount: 0 };
    const entries = [];
    for (let i = 0; i < (meta.chunkCount || 0); i++) {
        try {
            const chunkStr = await db.get(`${INDEX_KEY}_${i}`);
            entries.push(...(chunkStr ? JSON.parse(chunkStr) : []));
        } catch (err) {
            console.error(`dedup scan: failed to read chunk ${i}:`, err);
        }
    }

    const groups = new Map(); // sha256 -> [{ id, name, size, channel, timestamp }]
    let readErrors = 0;

    for (const entry of entries) {
        const fileId = entry.id;
        const metadata = entry.metadata || {};
        try {
            const resp = await fetch(`${origin}/file/${fileId}`);
            if (!resp.ok) {
                readErrors++;
                continue;
            }
            const digest = await crypto.subtle.digest('SHA-256', await resp.arrayBuffer());
            const hash = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
            if (!groups.has(hash)) groups.set(hash, []);
            groups.get(hash).push({
                id: fileId,
                name: metadata.FileName || fileId,
                size: metadata.FileSize || '',
                channel: metadata.ChannelName || metadata.Channel || '',
                timestamp: metadata.TimeStamp || 0,
            });
        } catch (err) {
            console.error(`dedup scan: failed to read ${fileId}:`, err);
            readErrors++;
        }
    }

    const duplicateGroups = [];
    let redundantCopies = 0;
    for (const [hash, items] of groups) {
        if (items.length < 2) continue;
        duplicateGroups.push({
            sha256: hash,
            count: items.length,
            keep: items[0], // 索引按时间升序写入,首项即最早
            duplicates: items.slice(1),
        });
        redundantCopies += items.length - 1;
    }

    return new Response(JSON.stringify({
        scanned: entries.length,
        readErrors,
        totalGroups: groups.size,
        duplicateGroups,
        redundantCopies,
        scannedAt: new Date().toISOString(),
    }, null, 2), {
        headers: { 'content-type': 'application/json' },
    });
}
