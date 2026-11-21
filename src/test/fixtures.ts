import { readFileSync } from 'node:fs';

/** Raw bytes of a feed fixture in fixtures/feed. */
export function feedFixture(name: string): Uint8Array {
	return new Uint8Array(readFileSync(new URL(`../../fixtures/feed/${name}`, import.meta.url)));
}

export function feedFixtureText(name: string): string {
	return new TextDecoder().decode(feedFixture(name));
}

/** Raw bytes of an OpenTimestamps fixture in fixtures/ots. */
export function otsFixture(name: string): Uint8Array {
	return new Uint8Array(readFileSync(new URL(`../../fixtures/ots/${name}`, import.meta.url)));
}
