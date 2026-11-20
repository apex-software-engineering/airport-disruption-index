/**
 * Independent verification of published rounds and prints. Each function returns the list of
 * problems found; an empty list is a match.
 */
import { canonicalJson, sha256Hex, type Json } from './json';
import { buildPrint, printHashMatches, type PrintRevision } from './print';
import { buildReceipt, outcomeFromReceipt, receiptHashMatches, summarizeReceipt } from './round';
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
	const rebuilt = buildReceipt({
		fetchedAt: new Date(receipt.fetchedAt),
		sourceUrl: receipt.sourceUrl,
		outcome: outcomeFromReceipt(receipt, raw),
	});
	return [
		...problems,
		...differingFields(receipt, rebuilt).map((field) => `recomputed ${field} differs`),
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
		print.correction === null ? { revision: 1 } : { revision: print.revision, ...print.correction };
	const rebuilt = buildPrint(print.date, receipts.map(summarizeReceipt), revision);
	return [
		...problems,
		...differingFields(print, rebuilt).map((field) => `recomputed ${field} differs`),
	];
}

function differingFields<T extends { readonly [key: string]: Json }>(
	published: T,
	rebuilt: T,
): string[] {
	const keys = new Set([...Object.keys(published), ...Object.keys(rebuilt)]);
	return [...keys].filter(
		(key) => canonicalJson(published[key] ?? null) !== canonicalJson(rebuilt[key] ?? null),
	);
}
