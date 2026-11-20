import { createHash } from 'node:crypto';

/** A JSON value. Everything that is hashed must be expressible as one. */
export type Json =
	null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace, numbers in their
 * shortest round-trip form (what `JSON.stringify` emits). Non-finite numbers are rejected
 * because JSON cannot carry them.
 */
export function canonicalJson(value: Json): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number ${value}`);
		return JSON.stringify(value);
	}
	if (isJsonArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(requireKey(value, key))}`).join(',')}}`;
}

function isJsonArray(
	value: readonly Json[] | { readonly [key: string]: Json },
): value is readonly Json[] {
	return Array.isArray(value);
}

function requireKey(value: { readonly [key: string]: Json }, key: string): Json {
	const entry = value[key];
	if (entry === undefined) throw new Error(`canonicalJson: undefined value at key ${key}`);
	return entry;
}

/** Lowercase hex sha256 of bytes or of a UTF-8 string. */
export function sha256Hex(data: string | Uint8Array): string {
	return createHash('sha256').update(data).digest('hex');
}

/** sha256 of the canonical JSON of a value. */
export function hashJson(value: Json): string {
	return sha256Hex(canonicalJson(value));
}
