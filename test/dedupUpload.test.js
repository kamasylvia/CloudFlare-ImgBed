import assert from 'node:assert/strict';
import { loadFunction, memoryDatabase } from './helpers/loadFunction.js';
import * as responses from '../functions/utils/apiResponse.js';

describe('content dedup on upload', () => {
    let db, tools, mocks, storage, waits, uploadCfg;

    beforeEach(async () => {
        db = memoryDatabase();
        storage = {};
        waits = [];
        uploadCfg = { dedup: { enabled: true } };
        tools = await loadFunction('functions/upload/uploadTools.js', { getDatabase: () => db });
        const { UnauthorizedResponse } = await loadFunction('functions/utils/auth/userAuth.js');
        mocks = {
            ...tools,
            ...responses,
            getDatabase: () => db,
            checkDatabaseConfig: () => ({ usingD1: false }),
            fetchSecurityConfig: async () => ({ upload: { moderate: { enabled: false } } }),
            fetchUploadConfig: async () => ({
                ...uploadCfg,
                cfr2: { channels: [{ name: 'mock' }] },
                telegram: { channels: [] },
                s3: { channels: [] },
                webdav: { channels: [] },
                huggingface: { channels: [] },
            }),
            fetchPageConfig: async () => ({ config: [] }),
            userAuthCheck: async () => true,
            UnauthorizedResponse,
            isBlockedUploadIp: async () => false,
            getIPAddress: async () => '',
            getUploadIp: () => '',
            moderateContent: async () => 'None',
            endUpload: async () => {},
            createS3Client: () => ({ async send() { return { ETag: 'etag' }; } }),
            PutObjectCommand: class { constructor(input) { this.input = input; } },
            TelegramAPI: class {},
            WebDAVAPI: class {},
            HuggingFaceAPI: class {},
            purgeCFCache: async () => {},
            purgeRandomFileListCache: async () => {},
            purgePublicFileListCache: async () => {},
        };
    });

    function context(name, content) {
        const form = new FormData();
        form.append('file', new File([content], name, { type: 'image/png' }));
        return {
            request: new Request('https://test/upload?uploadChannel=cfr2', { method: 'POST', body: form }),
            url: new URL('https://test/upload?uploadChannel=cfr2'),
            env: { img_r2: {
                async put() {},
                async get(id) { return storage[id] ?? null; },
                async delete(id) { delete storage[id]; },
            } },
            waitUntil(promise) { waits.push(promise); },
        };
    }

    async function srcOf(resp) {
        const body = await resp.json();
        assert.equal(resp.status, 200);
        return body[0].src;
    }

    it('returns the existing link on the second identical upload', async () => {
        const route = await loadFunction('functions/upload/index.js', mocks);
        const first = await srcOf(await route.onRequest(context('a.png', 'same-bytes')));
        const second = await srcOf(await route.onRequest(context('b.png', 'same-bytes')));
        assert.equal(second, first);
        // dedup 键已写入
        assert.notEqual(await db.get('manage@deduprev@' + first.replace('/file/', '')), null);
    });

    it('stores separate files for different content', async () => {
        const route = await loadFunction('functions/upload/index.js', mocks);
        const s1 = await srcOf(await route.onRequest(context('a.png', 'one')));
        const s2 = await srcOf(await route.onRequest(context('a.png', 'two')));
        assert.notEqual(s1, s2);
    });

    it('skips dedup when disabled in settings', async () => {
        uploadCfg.dedup = { enabled: false };
        const route = await loadFunction('functions/upload/index.js', mocks);
        const s1 = await srcOf(await route.onRequest(context('a.png', 'same')));
        const s2 = await srcOf(await route.onRequest(context('b.png', 'same')));
        assert.notEqual(s1, s2);
    });

    it('re-uploads the same content after deletion rolls back the dedup key', async () => {
        const route = await loadFunction('functions/upload/index.js', mocks);
        const first = await srcOf(await route.onRequest(context('a.png', 'reusable')));
        const fileId = first.replace('/file/', '');

        // 直接走 deleteFile(删除端点的核心),真实删除记录并回滚键
        const del = await loadFunction('functions/api/manage/delete/[[path]].js', mocks);
        const result = await del.deleteFile(mocks_env(), fileId, 'https://test/file/' + fileId, new URL('https://test'));
        assert.equal(result.deleted, true);
        assert.equal(result.existed, true);

        const again = await srcOf(await route.onRequest(context('c.png', 'reusable')));
        assert.notEqual(again, first);
    });

    function mocks_env() {
        return {
            img_r2: {
                async put() {},
                async get(id) { return storage[id] ?? null; },
                async delete(id) { delete storage[id]; },
            },
        };
    }
});
