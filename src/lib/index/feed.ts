/**
 * Parser for the FAA NAS Status airport feed
 * (https://nasstatus.faa.gov/api/airport-status-information).
 *
 * Delay_type blocks are classified by the list element they hold, not by `Name`: the same Name
 * can repeat, and old recordings carry blocks without one. Ground stops and ground delay
 * programs become events. Known lists v1 does not count are recorded as `ignored`; anything
 * else is recorded as `unrecognized` and never fails the parse. A GS/GDP list that holds an
 * element we do not know does fail the parse, because skipping it could silently drop an event;
 * so does a GS/GDP list anywhere but directly in a Delay_type block, or in a block whose `Name`
 * says it is something else.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';

import type { OtherDelayType, ProgramEvent } from './schemas';
import { parseFeedUpdateTime } from './time';

export type ParsedFeed = {
	updateTime: string;
	events: ProgramEvent[];
	otherDelayTypes: OtherDelayType[];
};

export type FeedParseResult = { ok: true; feed: ParsedFeed } | { ok: false; detail: string };

const ROOT = 'AIRPORT_STATUS_INFORMATION';
const GROUND_STOP_LIST = 'Ground_Stop_List';
const GROUND_DELAY_LIST = 'Ground_Delay_List';
/** The `Name` a block holding each counted list must carry, when it has a Name at all. */
const PROGRAM_BLOCK_NAMES: Record<string, string> = {
	[GROUND_STOP_LIST]: 'Ground Stop Programs',
	[GROUND_DELAY_LIST]: 'Ground Delay Programs',
};
/** `Program` is what the live feed and old recordings use; `Ground_Stop` appears in one fixture. */
const GROUND_STOP_ITEMS = ['Program', 'Ground_Stop'];
const GROUND_DELAY_ITEMS = ['Ground_Delay'];
const IGNORED_LISTS = new Set([
	'Arrival_Departure_Delay_List',
	'Airspace_Flow_List',
	'Airport_Closure_List',
]);

class FeedFormatError extends Error {}

const parser = new XMLParser({
	ignoreAttributes: true,
	parseTagValue: false,
	trimValues: true,
	// Delay_type blocks and the entries inside any list are always arrays, even when single.
	isArray: (_name, jpath) => {
		const depth = String(jpath).split('.').length;
		return String(jpath).startsWith(`${ROOT}.Delay_type`) && (depth === 2 || depth === 4);
	},
});

const documentSchema = z.record(z.string(), z.unknown());
const rootSchema = z.object({
	[ROOT]: z.object({
		Update_Time: z.string(),
		Delay_type: z.array(z.union([z.literal(''), z.record(z.string(), z.unknown())])).optional(),
	}),
});
/** An empty list element parses to ''; otherwise each child name maps to its entries. */
const listSchema = z.union([z.literal(''), z.record(z.string(), z.array(z.unknown()))]);
const optionalText = z.string().optional();
const groundStopSchema = z.object({
	ARPT: z.string().min(1),
	Reason: optionalText,
	End_Time: optionalText,
});
const groundDelaySchema = z.object({
	ARPT: z.string().min(1),
	Reason: optionalText,
	Avg: optionalText,
	Max: optionalText,
});

export function parseFeed(xml: string): FeedParseResult {
	const wellFormed = XMLValidator.validate(xml);
	if (wellFormed !== true) {
		return {
			ok: false,
			detail: `XML not well formed: ${wellFormed.err.msg} (line ${wellFormed.err.line})`,
		};
	}
	let tree: unknown;
	try {
		tree = parser.parse(xml);
	} catch (error) {
		return { ok: false, detail: `XML parser rejected the document: ${String(error)}` };
	}
	const document = documentSchema.safeParse(tree);
	const roots = document.success ? Object.keys(document.data).filter((key) => key !== '?xml') : [];
	if (roots.length !== 1 || roots[0] !== ROOT) {
		return { ok: false, detail: `expected exactly one ${ROOT} root, found [${roots.join(', ')}]` };
	}
	const root = rootSchema.safeParse(tree);
	if (!root.success)
		return { ok: false, detail: `not an ${ROOT} document: ${z.prettifyError(root.error)}` };
	const { Update_Time: updateTimeText, Delay_type: blocks = [] } = root.data[ROOT];
	for (const list of Object.keys(PROGRAM_BLOCK_NAMES)) {
		const inBlocks = blocks.filter((block) => block !== '' && list in block).length;
		if (countKey(tree, list) !== inBlocks) {
			return { ok: false, detail: `${list} found outside a Delay_type block` };
		}
	}
	const updateTime = parseFeedUpdateTime(updateTimeText);
	if (updateTime === null)
		return { ok: false, detail: `unparseable Update_Time "${updateTimeText}"` };
	try {
		const events: ProgramEvent[] = [];
		const otherDelayTypes: OtherDelayType[] = [];
		for (const block of blocks) readDelayType(block === '' ? {} : block, events, otherDelayTypes);
		return { ok: true, feed: { updateTime, events, otherDelayTypes } };
	} catch (error) {
		if (error instanceof FeedFormatError) return { ok: false, detail: error.message };
		throw error;
	}
}

function readDelayType(
	block: Record<string, unknown>,
	events: ProgramEvent[],
	others: OtherDelayType[],
): void {
	const name = typeof block.Name === 'string' ? block.Name : null;
	const lists = Object.keys(block).filter((key) => key !== 'Name');
	if (lists.length === 0)
		others.push({ disposition: 'unrecognized', name, element: null, entries: 0 });
	for (const element of lists) {
		const expectedName = PROGRAM_BLOCK_NAMES[element];
		if (expectedName !== undefined && name !== null && name !== expectedName) {
			throw new FeedFormatError(`${element} is in a Delay_type named "${name}"`);
		}
		const list = parseList(element, block[element]);
		if (element === GROUND_STOP_LIST) {
			for (const raw of entriesOf(element, list, GROUND_STOP_ITEMS)) {
				const entry = parseEntry(groundStopSchema, element, raw);
				events.push({
					program: 'ground_stop',
					airport: entry.ARPT,
					reason: entry.Reason ?? null,
					endTime: entry.End_Time ?? null,
				});
			}
		} else if (element === GROUND_DELAY_LIST) {
			for (const raw of entriesOf(element, list, GROUND_DELAY_ITEMS)) {
				const entry = parseEntry(groundDelaySchema, element, raw);
				events.push({
					program: 'ground_delay_program',
					airport: entry.ARPT,
					reason: entry.Reason ?? null,
					average: entry.Avg ?? null,
					maximum: entry.Max ?? null,
				});
			}
		} else {
			others.push({
				disposition: IGNORED_LISTS.has(element) ? 'ignored' : 'unrecognized',
				name,
				element,
				entries:
					list === null ? 0 : Object.values(list).reduce((sum, items) => sum + items.length, 0),
			});
		}
	}
}

/** null for an empty list element. Lists of unknown shape only fail the parse for GS/GDP. */
function parseList(element: string, value: unknown): Record<string, unknown[]> | null {
	const list = listSchema.safeParse(value);
	if (list.success) return list.data === '' ? null : list.data;
	if (element === GROUND_STOP_LIST || element === GROUND_DELAY_LIST) {
		throw new FeedFormatError(`${element} has an unexpected shape`);
	}
	return null;
}

function entriesOf(
	element: string,
	list: Record<string, unknown[]> | null,
	allowed: string[],
): unknown[] {
	if (list === null) return [];
	const unexpected = Object.keys(list).filter((child) => !allowed.includes(child));
	if (unexpected.length > 0) {
		throw new FeedFormatError(`${element} holds unexpected element(s) ${unexpected.join(', ')}`);
	}
	return allowed.flatMap((child) => list[child] ?? []);
}

function parseEntry<T>(schema: z.ZodType<T>, element: string, raw: unknown): T {
	const entry = schema.safeParse(raw);
	if (!entry.success)
		throw new FeedFormatError(`${element} entry invalid: ${z.prettifyError(entry.error)}`);
	return entry.data;
}

/** How many times `key` occurs as an element name anywhere in a parsed tree. */
function countKey(value: unknown, key: string): number {
	if (Array.isArray(value))
		return value.reduce((sum: number, item) => sum + countKey(item, key), 0);
	if (typeof value !== 'object' || value === null) return 0;
	return Object.entries(value).reduce(
		(sum: number, [name, child]) => sum + (name === key ? 1 : 0) + countKey(child, key),
		0,
	);
}
