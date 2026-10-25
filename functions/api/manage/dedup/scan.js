/**
 * 存量重复文件扫描(只读,仅 Node 服务端部署)
 *
 * POST /api/manage/dedup/scan
 *
 * 遍历分片索引,按渠道逐文件读取内容计算 SHA-256,按内容分组报告重复。
 * 纯信息性:不删除、不改链接;每组建议保留时间戳最早的一条。
 *
 * 部署限制:依赖 SERVER_RUNTIME === 'node' 能力标志(仅 Docker / Node.js
 * 服务端部署提供;Workers / Pages 包括绑定 D1 的场景均返回 501)。
 *
 * 有界执行:单文件大小上限(默认 100MB,可经 ?maxFileMB 调低),超限计入
 * skippedOversized;响应带完整性与失败范围,分片读取失败显式上报。
 *
 * 能力探测:GET 请求返回 {supported} 而不执行扫描,供前端统一禁用/隐藏入口。
 *
 * fork 扩展:R2 绑定之外,其余渠道(Telegram/S3 等)经回环 /file/ 读取并
 * 严格校验(见 readRecordBytes);上游版本仅支持 R2 绑定读取。
 */
import { getDatabase } from '../../../utils/databaseAdapter.js';

export async function onRequest(context) {
    const { request, env } = context;

    // 能力标志:只有 Node 服务端部署提供(Workers/Pages 即便绑定 D1 也没有)。
    // 判定前置且对任意方法生效:前端可经 GET 无副作用地探测能力,统一与扫描相同的判定
    if (env?.SERVER_RUNTIME !== 'node') {
        return new Response(JSON.stringify({
            error: 'duplicate scan is only available on Docker / Node.js server deployments',
            supported: false,
        }), {
            status: 501,
            headers: { 'content-type': 'application/json' },
        });
    }

    if (request.method === 'GET') {
        return new Response(JSON.stringify({ supported: true }), {
            headers: { 'content-type': 'application/json' },
        });
    }

    if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'method not allowed, use POST' }), {
            status: 405,
            headers: { 'content-type': 'application/json', 'allow': 'GET, POST' },
        });
    }

    const url = new URL(request.url);

    const parsedMax = parseInt(url.searchParams.get('maxFileMB') || '100', 10);
    const maxFileMB = Number.isFinite(parsedMax) && parsedMax >= 1 ? parsedMax : 100;
    const maxFileBytes = maxFileMB * 1024 * 1024;

    const db = getDatabase(env);

    // ===== 读取分片索引,显式报告读取失败 =====
    const INDEX_META_KEY = 'manage@index@meta';
    const INDEX_KEY = 'manage@index';
    const metaStr = await db.get(INDEX_META_KEY);
    const meta = metaStr ? JSON.parse(metaStr) : { chunkCount: 0 };
    const entries = [];
    const chunkErrors = [];
    for (let i = 0; i < (meta.chunkCount || 0); i++) {
        try {
            const chunkStr = await db.get(`${INDEX_KEY}_${i}`);
            const chunk = chunkStr ? JSON.parse(chunkStr) : [];
            entries.push(...chunk);
        } catch (err) {
            console.error(`dedup scan: failed to read chunk ${i}:`, err);
            chunkErrors.push({ chunk: i, error: String(err?.message || err) });
        }
    }
    const complete = chunkErrors.length === 0 && metaStr !== null;

    // ===== 逐条目读取记录元数据(记录缺失计入 recordErrors)=====
    const records = [];
    const recordErrors = [];
    for (const entry of entries) {
        try {
            const rec = await db.getWithMetadata(entry.id);
            if (rec === null || rec === undefined) {
                recordErrors.push({ id: entry.id, error: 'record not found' });
                continue;
            }
            records.push({ id: entry.id, metadata: rec.metadata || entry.metadata || {} });
        } catch (err) {
            recordErrors.push({ id: entry.id, error: String(err?.message || err) });
        }
    }

    // ===== 按记录元数据定位渠道并读取内容(管理员路径:直接读存储绑定,不经公开 /file/ 路由)=====
    const groups = new Map();
    const readErrors = [];
    const skippedOversized = [];
    for (const record of records) {
        const meta = record.metadata || {};
        const sizeBytes = Number(meta.FileSizeBytes || 0);
        if (sizeBytes > maxFileBytes) {
            skippedOversized.push(record.id);
            continue;
        }
        try {
            const bytes = await readRecordBytes(env, record.id, meta, url.origin, maxFileBytes);
            if (bytes === null) {
                readErrors.push({ id: record.id, error: 'content not readable via storage binding' });
                continue;
            }
            if (typeof bytes === 'string') {
                readErrors.push({ id: record.id, error: bytes });
                continue;
            }
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            const hash = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
            if (!groups.has(hash)) groups.set(hash, []);
            groups.get(hash).push({
                id: record.id,
                name: meta.FileName || record.id,
                size: meta.FileSize || '',
                channel: meta.ChannelName || meta.Channel || '',
                timestamp: meta.TimeStamp || 0,
            });
        } catch (err) {
            console.error(`dedup scan: failed to read ${record.id}:`, err);
            readErrors.push({ id: record.id, error: String(err?.message || err) });
        }
    }

    // ===== 分组:每组显式选时间戳最早的一条为建议保留(索引为倒序,不能取 items[0])=====
    const duplicateGroups = [];
    let redundantCopies = 0;
    for (const [hash, items] of groups) {
        if (items.length < 2) continue;
        const sorted = [...items].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        duplicateGroups.push({
            sha256: hash,
            count: items.length,
            keep: sorted[0],
            duplicates: sorted.slice(1),
        });
        redundantCopies += items.length - 1;
    }

    return new Response(JSON.stringify({
        complete,
        chunkErrors,
        scanned: records.length,
        recordErrors,
        readErrors,
        skippedOversized,
        totalGroups: groups.size,
        duplicateGroups,
        redundantCopies,
        scannedAt: new Date().toISOString(),
    }, null, 2), {
        headers: { 'content-type': 'application/json' },
    });
}

/**
 * 经存储绑定直接读取文件内容(管理员可信路径):
 * - R2: env.img_r2.get(id).body
 * - 其余渠道(fork 扩展,自托管 Node 部署):经回环 /file/ 读取真实字节。
 *   与 v1 的差别:严格校验响应,只接受 200 + 非 HTML/JSON/XML/纯文本,
 *   防止白名单页 / 错误页 / 登录跳转被当成文件内容算出假哈希;
 *   超过 maxFileBytes 返回描述字符串,计入 readErrors 而非默默跳过。
 *   上游 PR 维持仅 R2 绑定读取,不带此扩展。
 */
async function readRecordBytes(env, fileId, meta, origin, maxFileBytes) {
    if (meta.Channel === 'CloudflareR2' && env.img_r2?.get) {
        const obj = await env.img_r2.get(fileId);
        if (!obj || !obj.body) return null;
        return new Uint8Array(await new Response(obj.body).arrayBuffer());
    }
    if (origin) {
        let resp;
        try {
            resp = await fetch(`${origin}/file/${encodeURIComponent(fileId)}`);
        } catch (err) {
            return `loopback /file/ fetch failed: ${String(err?.message || err)}`;
        }
        if (!resp.ok) return `loopback /file/ read failed: HTTP ${resp.status}`;
        const ct = (resp.headers.get('content-type') || '').trim();
        if (/^text\/html|^application\/(json|xml)|^text\/plain/i.test(ct)) {
            return `loopback /file/ returned non-file content (content-type ${ct || 'unknown'})`;
        }
        const bytes = new Uint8Array(await resp.arrayBuffer());
        if (bytes.byteLength > maxFileBytes) {
            return `content size ${bytes.byteLength} exceeds maxFileMB cap`;
        }
        if (bytes.byteLength === 0) return 'loopback /file/ returned empty body';
        return bytes;
    }
    return null;
}
