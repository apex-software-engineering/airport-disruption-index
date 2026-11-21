/**
 * Independent verification of published rounds and prints. Each function returns the list of
 * problems found; an empty list is a match. Nothing here throws on bad data: a receipt or print
 * that cannot even be rebuilt is a problem to report, not a crash.
 */
import { canonicalJson, sha256Hex, type Json } from './json';
import { buildPrint, printHashMatches, type PrintRevision } from './print';
import {
	buildReceipt,
	outcomeFromReceipt,
	receiptHashMatches,
	recordedMethodology,
	summarizeReceipt,
} from './round';
import type { DailyPrint, RoundReceipt } from './schemas';

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
	const revision: PrintRevision =
		print.correction === null
			? { revision: 1 }
			: { revision: print.revision, correction: print.correction };
	return [
		...problems,
		...compareRebuilt(print, () =>
			buildPrint(print.date, receipts.map(summarizeReceipt), revision),
		),
	];
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
