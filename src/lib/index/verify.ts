/**
 * Independent verification of published rounds and prints. Each function returns the list of
 * problems found; an empty list is a match. Nothing here throws on bad data: a receipt or print
 * that cannot even be rebuilt is a problem to report, not a crash.
 */
import { dayWindow, settlementDay } from './calendar';
import { indicativeAdmissionFor, indicativeReleaseFor } from './indicative';
import { canonicalJson, sha256Hex, type Json } from './json';
import { methodologyOf } from './methodology';
import { buildIndicativePrint, buildPrint, printHashMatches, type PrintRevision } from './print';
import {
	buildReceipt,
	outcomeFromReceipt,
	receiptHashMatches,
	recordedMethodology,
	summarizeReceipt,
} from './round';
import type { DailyPrint, IndicativePrint, RoundReceipt } from './schemas';

/** Rebuilds a receipt from its archived body and compares every field. */
export function verifyRound(receipt: RoundReceipt, raw: Uint8Array | null): string[] {
	const problems: string[] = [];
	if (!receiptHashMatches(receipt))
		problems.push('receiptHash does not match the receipt contents');
	if (receipt.rawSha256 !== null) {
		if (raw === null) return [...problems, 'raw body is missing'];
		const actual = sha256Hex(raw);
		if (actual !== receipt.rawSha256)
			problems.push(`raw body sha256 ${actual} != rawSha256 ${receipt.rawSha256}`);
	}
	return [
		...problems,
		...compareRebuilt(receipt, () =>
			// Rebuilt under the methodology and adapter the receipt records, not the current ones.
			buildReceipt({
				fetchedAt: new Date(receipt.fetchedAt),
				sourceUrl: receipt.sourceUrl,
				outcome: outcomeFromReceipt(receipt, raw),
				methodology: recordedMethodology(receipt),
				adapterVersion: receipt.adapterVersion,
			}),
		),
	];
}

/** Rebuilds a print from the receipts it lists and compares every field. */
export function verifyPrint(print: DailyPrint, receipts: readonly RoundReceipt[]): string[] {
	const problems = listedReceiptProblems(print, receipts);
	const revision: PrintRevision =
		print.correction === null
			? { revision: 1 }
			: { revision: print.revision, correction: print.correction };
	return [
		...problems,
		...compareRebuilt(print, () =>
			buildPrint(settlementDay(print.date), receipts.map(summarizeReceipt), revision),
		),
	];
}

/**
 * Rebuilds an indicative print from the receipts it lists, under the release `indicativeReleaseFor`
 * gives its date (never the one in effect), and compares every field.
 */
export function verifyIndicativePrint(
	print: IndicativePrint,
	receipts: readonly RoundReceipt[],
): string[] {
	const problems = listedReceiptProblems(print, receipts);
	const recorded = methodologyOf(print.methodologyVersion, print.parameterHash);
	const release = indicativeReleaseFor(print.date, { includeWithdrawn: true });
	if (recorded === null || recorded !== release) {
		return [
			...problems,
			`records ${print.methodologyVersion}, but ${print.date}'s indicative release is ${release?.parameters.version ?? 'none'}`,
		];
	}
	const admission = indicativeAdmissionFor(release);
	if (admission === null)
		return [...problems, `${release.parameters.version} has no indicative series`];
	return [
		...problems,
		...compareRebuilt(print, () =>
			buildIndicativePrint(
				{ release, window: dayWindow(release, print.date) },
				receipts.map(summarizeReceipt),
				admission,
			),
		),
	];
}

/** The print's own hash, and the receipts it lists against those supplied, by id and hash. */
function listedReceiptProblems(
	print: DailyPrint | IndicativePrint,
	receipts: readonly RoundReceipt[],
): string[] {
	const problems: string[] = [];
	if (!printHashMatches(print)) problems.push('printHash does not match the print contents');
	const listed = new Map(print.rounds.map((r) => [r.roundId, r.receiptHash]));
	for (const receipt of receipts) {
		if (listed.get(receipt.roundId) !== receipt.receiptHash) {
			problems.push(
				`receipt ${receipt.roundId} has hash ${receipt.receiptHash}, print lists ${listed.get(receipt.roundId)}`,
			);
		}
	}
	if (receipts.length !== print.rounds.length) {
		problems.push(`print lists ${print.rounds.length} rounds, ${receipts.length} supplied`);
	}
	return problems;
}

/**
 * Checks a settled day response is self-consistent: revisions numbered 1..n for that date, and
 * `print` the last of them. Duplicate or conflicting revisions fail here.
 */
export function dayResponseProblems(
	date: string,
	print: DailyPrint,
	revisions: readonly DailyPrint[],
): string[] {
	const problems: string[] = [];
	if (print.date !== date) problems.push(`asked for day ${date}, got a print for ${print.date}`);
	revisions.forEach((revision, index) => {
		if (revision.date !== date)
			problems.push(`revisions[${index}] is a print for ${revision.date}, not ${date}`);
		if (revision.revision !== index + 1)
			problems.push(`revisions[${index}] is revision ${revision.revision}, expected ${index + 1}`);
	});
	const last = revisions.at(-1);
	if (last === undefined || canonicalJson(last) !== canonicalJson(print))
		problems.push('print is not the last entry in revisions');
	return problems;
}

function compareRebuilt<T extends { readonly [key: string]: Json }>(
	published: T,
	rebuild: () => T,
): string[] {
	let rebuilt: T;
	try {
		rebuilt = rebuild();
	} catch (error) {
		return [`cannot be rebuilt: ${error instanceof Error ? error.message : String(error)}`];
	}
	const keys = new Set([...Object.keys(published), ...Object.keys(rebuilt)]);
	return [...keys]
		.filter((key) => canonicalJson(published[key] ?? null) !== canonicalJson(rebuilt[key] ?? null))
		.map((field) => `recomputed ${field} differs`);
}
