/**
 * 引用登记中枢(fork-only,见 fork 仓库 issue #1 / 上游 issue #771):
 * 各客户端上报「自己全部文档里引用的图床 URL 集合」全量快照;
 * 孤儿文件 = 文件索引 − union(各源快照),纯元数据差集,不读文件字节。
 *
 * 存储(经 databaseAdapter 抽象,Workers KV/D1 与自建部署均可):
 * - manage@refs@<source> → { updatedAt, ids: [...] }  归一化后的 file id 集合
 * - manage@refs@sources → { sources: { <source>: { updatedAt, count } } } 注册表
 */

export const REFERENCE_SOURCES_KEY = 'manage@refs@sources';
export const SOURCE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export const MAX_URLS_PER_SNAPSHOT = 200000;

function referenceKey(source) {
    return `manage@refs@${source}`;
}

/**
 * 从任意引用形式(URL / 相对路径)提取 file id:
 * 取 pathname 中 /file/ 之后的末段并 decode;不是 /file/ 引用返回 null(计入 skipped)。
 * 客户端可能上报 publicUrl 前缀、uploadUrl 前缀或裸 /file/ 路径,统一按末段归一。
 */
export function extractFileId(raw) {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (!value || value.length > 2048) return null;
    let pathname;
    try {
        pathname = new URL(value, 'https://reference.invalid').pathname;
    } catch (err) {
        return null;
    }
    const decoded = decodeURIComponent(pathname);
    const m = decoded.match(/^\/file\/(.+)$/);
    if (!m) return null;
    const id = m[1];
    // id 自身不能再含路径分隔(文件 id 形如 <ts>_<name>,/ 已在上层路径处理)
    if (!id || id.includes('/') || id.length > 512) return null;
    return id;
}

/**
 * 归一化一整个快照:非法项计入 skipped,合法项按首次出现去重。
 */
export function normalizeSnapshotUrls(urls) {
    if (!Array.isArray(urls)) return { error: 'urls must be an array' };
    if (urls.length > MAX_URLS_PER_SNAPSHOT) {
        return { error: `urls exceeds the per-snapshot limit of ${MAX_URLS_PER_SNAPSHOT}` };
    }
    const ids = [];
    const seen = new Set();
    let skipped = 0;
    for (const raw of urls) {
        const id = extractFileId(raw);
        if (id === null) { skipped++; continue; }
        if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
    return { ids, skipped };
}

export async function readSourcesRegistry(db) {
    try {
        const raw = await db.get(REFERENCE_SOURCES_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === 'object' && parsed.sources && typeof parsed.sources === 'object') {
            return parsed;
        }
    } catch (err) {
        console.error('reference registry: failed to read sources registry:', err);
    }
    return { sources: {} };
}

export async function writeSourcesRegistry(db, registry) {
    await db.put(REFERENCE_SOURCES_KEY, JSON.stringify(registry));
}

/** 快照 upsert:写快照键 + 刷新注册表;返回 { updatedAt, count, skipped } */
export async function saveSourceSnapshot(db, source, ids, { skipped = 0, reportedAt = null } = {}) {
    const now = Date.now();
    const updatedAt = Number.isFinite(reportedAt) && reportedAt > 0 ? reportedAt : now;
    await db.put(referenceKey(source), JSON.stringify({ updatedAt, ids }));
    const registry = await readSourcesRegistry(db);
    registry.sources[source] = { updatedAt, count: ids.length };
    await writeSourcesRegistry(db, registry);
    return { updatedAt, count: ids.length, skipped };
}

/** 注销源:删快照 + 从注册表移除;返回是否确实存在过 */
export async function deleteSourceSnapshot(db, source) {
    const registry = await readSourcesRegistry(db);
    const existed = Object.prototype.hasOwnProperty.call(registry.sources, source);
    await db.delete(referenceKey(source));
    if (existed) {
        delete registry.sources[source];
        await writeSourcesRegistry(db, registry);
    }
    return existed;
}

/** 各源快照状态(含停滞天数;reportedAt 仅测试注入用) */
export async function listSourceSnapshots(db, { now = Date.now() } = {}) {
    const registry = await readSourcesRegistry(db);
    return Object.entries(registry.sources)
        .map(([name, info]) => ({
            name,
            updatedAt: info.updatedAt ?? null,
            count: info.count ?? 0,
            staleDays: info.updatedAt ? Math.floor((now - info.updatedAt) / 86400000) : null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** 读取全部源快照的 id 并集(以及每源独立集合,便于报告) */
export async function loadReferencedIdSets(db, sourceNames, deadline) {
    const perSource = new Map();
    const union = new Set();
    for (const name of sourceNames) {
        let snapshot = null;
        try {
            const raw = await db.get(referenceKey(name));
            snapshot = raw ? JSON.parse(raw) : null;
        } catch (err) {
            console.error(`reference registry: failed to read snapshot ${name}:`, err);
            snapshot = null;
        }
        const ids = Array.isArray(snapshot?.ids) ? snapshot.ids.filter(x => typeof x === 'string') : [];
        const set = new Set(ids);
        perSource.set(name, set);
        for (const id of set) union.add(id);
        if (deadline && Date.now() >= deadline) break;
    }
    return { perSource, union };
}

/**
 * 读取文件索引条目(与 dedup scan 相同的分片协议与容错语义)。
 * 返回 { entries, chunkErrors, metaStr };调用方负责 indexChanged 复核与 complete 判定。
 */
export async function readIndexEntries(db, deadline) {
    const INDEX_META_KEY = 'manage@index@meta';
    const INDEX_KEY = 'manage@index';
    const meta = { chunkCount: 0 };
    const chunkErrors = [];
    let metaStr = null;
    let metaReadFailed = false;
    try {
        metaStr = await db.get(INDEX_META_KEY);
    } catch (err) {
        console.error('reference registry: failed to read index meta:', err);
        chunkErrors.push({ chunk: 'meta', error: String(err?.message || err) });
        metaReadFailed = true;
    }
    if (!metaReadFailed && metaStr !== null && metaStr !== undefined) {
        try {
            const parsed = JSON.parse(metaStr);
            if (!Number.isSafeInteger(parsed?.chunkCount) || parsed.chunkCount < 0) {
                throw new Error('invalid index chunk count');
            }
            meta.chunkCount = parsed.chunkCount;
        } catch (err) {
            console.error('reference registry: failed to parse index meta:', err);
            chunkErrors.push({ chunk: 'meta', error: String(err?.message || err) });
        }
    } else if (!metaReadFailed) {
        chunkErrors.push({ chunk: 'meta', error: 'index meta missing' });
    }
    const entries = [];
    for (let i = 0; i < (meta.chunkCount || 0); i++) {
        if (deadline && Date.now() >= deadline) break;
        try {
            const chunkStr = await db.get(`${INDEX_KEY}_${i}`);
            if (chunkStr === null || chunkStr === undefined) {
                chunkErrors.push({ chunk: i, error: 'chunk missing' });
                continue;
            }
            const chunk = JSON.parse(chunkStr);
            if (!Array.isArray(chunk)) throw new Error('invalid index chunk');
            for (const entry of chunk) entries.push(entry);
        } catch (err) {
            console.error(`reference registry: failed to read chunk ${i}:`, err);
            chunkErrors.push({ chunk: i, error: String(err?.message || err) });
        }
    }
    return { entries, chunkErrors, metaStr };
}
