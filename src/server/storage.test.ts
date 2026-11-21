import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A fake of the Vercel Blob SDK with the ETag behavior the real one has: put({ ifMatch }) and
 * head() use the strong ETag, while get() reports the HTTP response ETag, which arrives weak.
 */
const blobs = new Map<string, { body: Buffer; etag: string }>();
let writes = 0;

vi.mock('@vercel/blob', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@vercel/blob')>();
	return {
		...actual,
		head: async (pathname: string) => {
			const blob = blobs.get(pathname);
			if (blob === undefined) throw new actual.BlobNotFoundError();
			return { pathname, etag: blob.etag };
		},
		get: async (pathname: string) => {
			const blob = blobs.get(pathname);
			if (blob === undefined) return null;
			return {
				statusCode: 200,
				stream: new Response(new Uint8Array(blob.body)).body,
				blob: { etag: `W/${blob.etag}` },
			};
		},
		put: async (pathname: string, body: Buffer, options: { ifMatch?: string }) => {
			const current = blobs.get(pathname);
			if (options.ifMatch !== undefined) {
				if (current?.etag !== options.ifMatch) throw new actual.BlobPreconditionFailedError();
			} else if (current !== undefined) {
				throw new actual.BlobError('This blob already exists');
			}
			writes += 1;
			blobs.set(pathname, { body, etag: `"etag-${writes}"` });
			return { pathname };
		},
	};
});

const { BlobStore, storeTarget } = await import('./storage');

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (body: Uint8Array) => new TextDecoder().decode(body);

describe('BlobStore versions', () => {
	beforeEach(() => blobs.clear());

	it('lets a conditional write succeed with the version a read returned', async () => {
		const store = new BlobStore('preview', 'token');
		expect(
			await store.write('days/x.json', bytes('a'), 'application/json', { kind: 'if-absent' }),
		).toBe('written');
		const first = await store.read('days/x.json');
		if (first === null) throw new Error('missing');
		expect(
			await store.write('days/x.json', bytes('b'), 'application/json', {
				kind: 'if-version',
				version: first.version,
			}),
		).toBe('written');
		const second = await store.read('days/x.json');
		expect(second && text(second.body)).toBe('b');
	});

	it('rejects a conditional write with a stale version and a second if-absent write', async () => {
		const store = new BlobStore('preview', 'token');
		await store.write('days/x.json', bytes('a'), 'application/json', { kind: 'if-absent' });
		const stale = await store.read('days/x.json');
		if (stale === null) throw new Error('missing');
		await store.write('days/x.json', bytes('b'), 'application/json', {
			kind: 'if-version',
			version: stale.version,
		});
		expect(
			await store.write('days/x.json', bytes('c'), 'application/json', {
				kind: 'if-version',
				version: stale.version,
			}),
		).toBe('conflict');
		expect(
			await store.write('days/x.json', bytes('d'), 'application/json', { kind: 'if-absent' }),
		).toBe('conflict');
		expect(await store.read('days/missing.json')).toBeNull();
	});
});

describe('storeTarget', () => {
	it('names the store, warns when both stores are named, and never guesses one', () => {
		expect(storeTarget({ VERCEL_ENV: 'production' })).toEqual({
			name: 'Vercel Blob, VERCEL_ENV=production',
			warning: null,
		});
		expect(storeTarget({ ADI_DATA_DIR: '/tmp/x' })).toEqual({
			name: 'filesystem store /tmp/x',
			warning: null,
		});
		expect(storeTarget({ ADI_DATA_DIR: '/tmp/x', VERCEL_ENV: 'production' })).toMatchObject({
			name: 'filesystem store /tmp/x',
			warning: expect.stringMatching(/both set; ADI_DATA_DIR wins/),
		});
		expect(storeTarget({ BLOB_READ_WRITE_TOKEN: 'x' })).toBeNull();
	});
});
