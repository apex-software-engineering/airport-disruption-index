/**
 * Preloaded into the fixture servers only (`NODE_OPTIONS=--import`), never into the app: their
 * clock starts at `ADI_FIXTURE_NOW` and advances in real time. The fixture history is dated
 * relative to that instant, so every fixture day is one a release governs, which the archive
 * requires before it serves a day (it never serves a date before the first release).
 */
const start = Date.parse(process.env.ADI_FIXTURE_NOW ?? '');
if (Number.isNaN(start)) throw new Error('ADI_FIXTURE_NOW must be an ISO instant');

const RealDate = Date;
const offset = start - RealDate.now();

class FixtureDate extends RealDate {
	constructor(...args) {
		if (args.length === 0) super(RealDate.now() + offset);
		else super(...args);
	}

	static now() {
		return RealDate.now() + offset;
	}
}

// Own statics, not inherited ones: Next.js wraps Date by copying its own properties.
FixtureDate.UTC = RealDate.UTC;
FixtureDate.parse = RealDate.parse;

globalThis.Date = FixtureDate;
