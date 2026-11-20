/**
 * Object storage behind one small interface: Vercel Blob in deployments, the filesystem for
 * tests, local runs and the reproduce script. Keys are namespaced by environment so a preview
 * deployment can never write into production's data.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
	BlobError,
	BlobNotFoundError,
	BlobPreconditionFailedError,
	get,
	head,
	list,
	put,
} from '@vercel/blob';

export type StoredObject = { body: Uint8Array; version: string };

/** How a write treats an existing object. `version` comes from a previous `read`. */
export type WriteCondition =
	{ kind: 'if-absent' } | { kind: 'if-version'; version: string } | { kind: 'overwrite' };

export interface ObjectStore {
	read(key: string): Promise<StoredObject | null>;
	/** 'conflict' when the condition does not hold; nothing is written then. */
	write(
		key: string,
		body: Uint8Array,
		contentType: string,
		condition: WriteCondition,
	): Promise<'written' | 'conflict'>;
	/** Keys (without namespace) starting with `prefix`. */
	list(prefix: string): Promise<string[]>;
}

export class BlobStore implements ObjectStore {
	constructor(
		private readonly namespace: string,
		private readonly token: string,
	) {}

	private path(key: string): string {
		return `${this.namespace}/${key}`;
	}

	async read(key: string): Promise<StoredObject | null> {
		const result = await get(this.path(key), {
			access: 'private',
			useCache: false,
			token: this.token,
		});
		if (result === null) return null;
		if (result.statusCode !== 200)
			throw new Error(`blob read ${key}: unexpected status ${result.statusCode}`);
		const body = new Uint8Array(await new Response(result.stream).arrayBuffer());
		return { body, version: result.blob.etag };
	}

	async write(key: string, body: Uint8Array, contentType: string, condition: WriteCondition) {
		const options = {
			access: 'private',
			contentType,
			token: this.token,
			addRandomSuffix: false,
			...(condition.kind === 'overwrite' ? { allowOverwrite: true } : {}),
			...(condition.kind === 'if-version' ? { ifMatch: condition.version } : {}),
		} as const;
		try {
			await put(this.path(key), Buffer.from(body), options);
			return 'written';
		} catch (error) {
			if (error instanceof BlobPreconditionFailedError) return 'conflict';
			// An existing blob without allowOverwrite is a generic BlobError; confirm by looking.
			if (condition.kind === 'if-absent' && error instanceof BlobError && (await this.exists(key)))
				return 'conflict';
			throw error;
		}
	}

	private async exists(key: string): Promise<boolean> {
		try {
			await head(this.path(key), { token: this.token });
			return true;
		} catch (error) {
			if (error instanceof BlobNotFoundError) return false;
			throw error;
		}
	}

	async list(prefix: string): Promise<string[]> {
		const keys: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await list({ prefix: this.path(prefix), cursor, token: this.token });
			keys.push(...page.blobs.map((blob) => blob.pathname.slice(this.namespace.length + 1)));
			cursor = page.hasMore ? page.cursor : undefined;
		} while (cursor !== undefined);
		return keys.sort();
	}
}

/** Filesystem store. Versions are content hashes; conditional writes are not atomic across processes. */
export class FileStore implements ObjectStore {
	constructor(private readonly root: string) {}

	private path(key: string): string {
		const resolved = path.resolve(this.root, key);
		if (!resolved.startsWith(path.resolve(this.root) + path.sep))
			throw new Error(`key escapes store: ${key}`);
		return resolved;
	}

	async read(key: string): Promise<StoredObject | null> {
		try {
			const body = new Uint8Array(await readFile(this.path(key)));
			return { body, version: createHash('sha256').update(body).digest('hex') };
		} catch (error) {
			if (isErrno(error, 'ENOENT')) return null;
			throw error;
		}
	}

	async write(key: string, body: Uint8Array, _contentType: string, condition: WriteCondition) {
		const file = this.path(key);
		await mkdir(path.dirname(file), { recursive: true });
		if (condition.kind === 'if-version') {
			const current = await this.read(key);
			if (current === null || current.version !== condition.version) return 'conflict';
		}
		try {
			await writeFile(file, body, { flag: condition.kind === 'if-absent' ? 'wx' : 'w' });
			return 'written';
		} catch (error) {
			if (isErrno(error, 'EEXIST')) return 'conflict';
			throw error;
		}
	}

	async list(prefix: string): Promise<string[]> {
		const dir = path.dirname(this.path(`${prefix}x`));
		try {
			const entries = await readdir(dir, { recursive: true, withFileTypes: true });
			return entries
				.filter((entry) => entry.isFile())
				.map((entry) =>
					path
						.relative(this.root, path.join(entry.parentPath, entry.name))
						.split(path.sep)
						.join('/'),
				)
				.filter((key) => key.startsWith(prefix))
				.sort();
		} catch (error) {
			if (isErrno(error, 'ENOENT')) return [];
			throw error;
		}
	}
}

function isErrno(error: unknown, code: string): boolean {
	return error instanceof Error && 'code' in error && error.code === code;
}

const NAMESPACES: Record<string, string> = {
	production: 'prod',
	preview: 'preview',
	development: 'dev',
};

/**
 * The store for this process. `ADI_DATA_DIR` selects a filesystem store (local runs); otherwise
 * Vercel Blob, namespaced by `VERCEL_ENV` (`local` when not on Vercel).
 */
export function storeFromEnv(env: NodeJS.ProcessEnv = process.env): ObjectStore {
	if (env.ADI_DATA_DIR) return new FileStore(env.ADI_DATA_DIR);
	const token = env.BLOB_READ_WRITE_TOKEN;
	if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set and ADI_DATA_DIR is not set');
	const namespace = env.VERCEL_ENV ? NAMESPACES[env.VERCEL_ENV] : 'local';
	if (namespace === undefined) throw new Error(`unknown VERCEL_ENV ${env.VERCEL_ENV}`);
	return new BlobStore(namespace, token);
}
