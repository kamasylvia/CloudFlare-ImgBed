import assert from 'node:assert/strict';
import { loadFunction } from './helpers/loadFunction.js';
import { createContext } from './helpers/context.js';
import { managementFixture } from './helpers/management.js';

describe('reference registry (read-only orphans, fork-only)', () => {
    let fixture, listRoute, sourceRoute, orphansRoute;

    beforeEach(async () => {
        fixture = await managementFixture();
        const registry = await loadFunction('functions/utils/referenceRegistry.js', fixture.mocks);
        const mocks = { ...fixture.mocks, ...registry };
        listRoute = await loadFunction('functions/api/manage/references/index.js', mocks);
        sourceRoute = await loadFunction('functions/api/manage/references/[source].js', mocks);
        orphansRoute = await loadFunction('functions/api/manage/references/orphans.js', mocks);
    });

    function sourceCtx(source, extra = {}) {
        return createContext(`https://test/api/manage/references/${source}`, {
            method: 'POST',
            params: { source },
            ...extra,
        });
    }

    function orphansCtx(query = '') {
        return createContext(`https://test/api/manage/references/orphans${query}`, { method: 'GET' });
    }

    async function seedIndex(files) {
        await fixture.db.put('manage@index@meta', JSON.stringify({ chunkCount: 1, totalCount: files.length }));
        await fixture.db.put('manage@index_0', JSON.stringify(files.map(({ id, metadata }) => ({ id, metadata }))));
        for (const file of files) {
            await fixture.db.put(file.id, '', { metadata: file.metadata });
        }
    }

    it('normalizes full URLs, path forms and rejects invalid source names', async () => {
        const res = await sourceRoute.onRequest(sourceCtx('siyuan', {
            body: JSON.stringify({
                urls: [
                    'http://qnap.example:7658/file/1790000000001_a.png',
                    '/file/1790000000002_b.jpg?x=1',
                    'https://host/file/1790000000003_c.webp#frag',
                    'not-a-file-link',
                    'http://qnap.example:7658/file/1790000000001_a.png',
                ],
            }),
        }));
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.stored, 3);
        assert.equal(body.skipped, 1);
        assert.equal(body.received, 5);

        const bad = await sourceRoute.onRequest(sourceCtx('bad name!'));
        assert.equal(bad.status, 400);
    });

    it('snapshot upsert is idempotent and the registry tracks counts and stale days', async () => {
        await sourceRoute.onRequest(sourceCtx('siyuan', { body: JSON.stringify({ urls: ['/file/a1.png'] }) }));
        const r2 = await sourceRoute.onRequest(sourceCtx('siyuan', { body: JSON.stringify({ urls: ['/file/a1.png', '/file/a2.png'] }) }));
        const body2 = await r2.json();
        assert.equal(body2.stored, 2);

        const list = await (await listRoute.onRequest(createContext('https://test/api/manage/references', { method: 'GET' }))).json();
        assert.equal(list.sources.length, 1);
        assert.equal(list.sources[0].name, 'siyuan');
        assert.equal(list.sources[0].count, 2);
        assert.equal(list.sources[0].staleDays, 0);
    });

    it('computes orphans as index minus the union of all source snapshots', async () => {
        await seedIndex([
            { id: 'ref1.png', metadata: { FileName: 'ref1.png', Channel: 'CloudflareR2', TimeStamp: 100 } },
            { id: 'ref2.png', metadata: { FileName: 'ref2.png', Channel: 'CloudflareR2', TimeStamp: 110 } },
            { id: 'orph1.png', metadata: { FileName: 'orph1.png', Channel: 'CloudflareR2', TimeStamp: 120 } },
            { id: 'orph2.png', metadata: { FileName: 'orph2.png', Channel: 'S3', TimeStamp: 130 } },
        ]);
        await sourceRoute.onRequest(sourceCtx('siyuan', { body: JSON.stringify({ urls: ['http://h/file/ref1.png'] }) }));
        await sourceRoute.onRequest(sourceCtx('obsidian', { body: JSON.stringify({ urls: ['/file/ref2.png'] }) }));

        const body = await (await orphansRoute.onRequest(orphansCtx())).json();
        assert.equal(body.complete, true);
        assert.equal(body.totalFiles, 4);
        assert.equal(body.referencedCount, 2);
        assert.equal(body.orphanCount, 2);
        assert.deepEqual(body.orphans.map(o => o.id), ['orph1.png', 'orph2.png']);
        assert.equal(body.sources.length, 2);
    });

    it('deleting one source removes it from the union so its files reappear as orphans', async () => {
        await seedIndex([
            { id: 'ref1.png', metadata: { FileName: 'ref1.png', Channel: 'CloudflareR2', TimeStamp: 100 } },
            { id: 'orph1.png', metadata: { FileName: 'orph1.png', Channel: 'CloudflareR2', TimeStamp: 120 } },
        ]);
        await sourceRoute.onRequest(sourceCtx('siyuan', { body: JSON.stringify({ urls: ['/file/ref1.png'] }) }));
        await sourceRoute.onRequest(sourceCtx('obsidian', { body: JSON.stringify({ urls: [] }) }));
        let body = await (await orphansRoute.onRequest(orphansCtx())).json();
        assert.equal(body.orphanCount, 1);

        const del = await sourceRoute.onRequest(sourceCtx('obsidian', { method: 'DELETE' }));
        assert.equal(del.status, 200);
        assert.equal((await del.json()).existed, true);
        // obsidian 注销后 siyuan 仍在:orphan 集合 = 索引 − siyuan 快照
        body = await (await orphansRoute.onRequest(orphansCtx())).json();
        assert.equal(body.orphanCount, 1);
        assert.equal(body.sources.length, 1);
        assert.equal(body.sources[0].name, 'siyuan');
    });

    it('unregistering the last source returns the report to the conservative empty state', async () => {
        await seedIndex([
            { id: 'a.png', metadata: { FileName: 'a.png', Channel: 'CloudflareR2', TimeStamp: 1 } },
        ]);
        await sourceRoute.onRequest(sourceCtx('siyuan', { body: JSON.stringify({ urls: ['/file/a.png'] }) }));
        await sourceRoute.onRequest(sourceCtx('siyuan', { method: 'DELETE' }));
        const body = await (await orphansRoute.onRequest(orphansCtx())).json();
        // 未登记 ≠ 无引用:注销最后一个源后回到保守空报告
        assert.equal(body.noSources, true);
        assert.equal(body.orphanCount, 0);
    });

    it('returns an empty report before any source has reported (conservative)', async () => {
        await seedIndex([
            { id: 'a.png', metadata: { FileName: 'a.png', Channel: 'CloudflareR2', TimeStamp: 1 } },
            { id: 'b.png', metadata: { FileName: 'b.png', Channel: 'CloudflareR2', TimeStamp: 2 } },
        ]);
        const body = await (await orphansRoute.onRequest(orphansCtx())).json();
        // 无源上报时不能把全部文件判成孤儿:未登记 ≠ 无引用
        assert.equal(body.noSources, true);
        assert.equal(body.orphanCount, 0);
        assert.equal(body.complete, true);
    });

    it('reports incompleteness on missing index chunks instead of fake-complete orphans', async () => {
        await seedIndex([
            { id: 'ref1.png', metadata: { FileName: 'ref1.png', Channel: 'CloudflareR2', TimeStamp: 100 } },
        ]);
        await sourceRoute.onRequest(sourceCtx('siyuan', { body: JSON.stringify({ urls: ['/file/ref1.png'] }) }));
        await fixture.db.put('manage@index@meta', JSON.stringify({ chunkCount: 2, totalCount: 1 }));

        const body = await (await orphansRoute.onRequest(orphansCtx())).json();
        assert.equal(body.complete, false);
        assert.ok(body.chunkErrors.some(e => e.chunk === 1 && /missing/.test(e.error)));
    });

    it('stops within the time budget and marks the report timedOut and incomplete', async () => {
        await seedIndex([
            { id: 'a.png', metadata: { FileName: 'a.png', Channel: 'CloudflareR2', TimeStamp: 1 } },
            { id: 'b.png', metadata: { FileName: 'b.png', Channel: 'CloudflareR2', TimeStamp: 2 } },
        ]);
        await sourceRoute.onRequest(sourceCtx('siyuan', { body: JSON.stringify({ urls: ['/file/a.png'] }) }));
        const body = await (await orphansRoute.onRequest(orphansCtx('?timeoutMs=0'))).json();
        assert.equal(body.complete, false);
        assert.equal(body.timedOut, true);
    });

    it('rejects oversized snapshots and non-array urls', async () => {
        const bad = await sourceRoute.onRequest(sourceCtx('siyuan', { body: JSON.stringify({ urls: 'not-an-array' }) }));
        assert.equal(bad.status, 400);
        const big = await sourceRoute.onRequest(sourceCtx('siyuan', { body: JSON.stringify({ urls: new Array(200001).fill('/file/x.png') }) }));
        assert.equal(big.status, 400);
    });
});
