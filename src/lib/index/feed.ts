/**
 * Parser for the FAA NAS Status airport feed
 * (https://nasstatus.faa.gov/api/airport-status-information).
 *
 * Delay_type blocks are classified by the list element they hold, not by `Name`: the same Name
 * can repeat across blocks, and old recordings carry uncounted blocks without one. Ground stops and ground delay
 * programs become events. Known lists v1 does not count are recorded as `ignored`; anything
 * else is recorded as `unrecognized` and never fails the parse. A GS/GDP list that holds an
 * element we do not know does fail the parse, because skipping it could silently drop an event;
 * so does a GS/GDP list anywhere but directly in a Delay_type block, or in a block without
 * exactly one `Name` naming that list. With `checked` structure (adapter faa-nas-xml/2), an
 * unknown root element, or a counted-program block without exactly its list, fails as
 * `unrecognized_structure` instead of being recorded as `unrecognized`.
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

/**
 * `unrecognized_structure` (adapter faa-nas-xml/2 onward) is a document whose root holds an
 * element the feed has never carried, or a block named for a counted program that does not hold
 * exactly that program's list: a renamed wrapper or list could otherwise read as an all-clear.
 */
export type FeedParseResult =
	| { ok: true; feed: ParsedFeed }
	| { ok: false; reason: 'parse_error' | 'unrecognized_structure'; detail: string };

/**
 * `checked` (adapter faa-nas-xml/2) fails closed on structure the feed has never carried: a
 * root child outside FAA_ROOT_CHILDREN, or a counted-program block without exactly its list.
 * `unchecked` is the original rule of adapter faa-nas-xml/1, kept so its receipts rebuild exactly.
 */
export type StructureCheck = 'unchecked' | 'checked';

/** Every root child seen in the archived fixtures and in sampled production bodies. */
const FAA_ROOT_CHILDREN: ReadonlySet<string> = new Set(['Update_Time', 'Dtd_File', 'Delay_type']);

const ROOT = 'AIRPORT_STATUS_INFORMATION';
const GROUND_STOP_LIST = 'Ground_Stop_List';
const GROUND_DELAY_LIST = 'Ground_Delay_List';
/** The one `Name` a block holding each counted list must carry. */
const PROGRAM_BLOCK_NAMES = new Map([
	[GROUND_STOP_LIST, 'Ground Stop Programs'],
	[GROUND_DELAY_LIST, 'Ground Delay Programs'],
]);
/** `Program` is what the live feed and old recordings use; `Ground_Stop` appears in one fixture. */
const GROUND_STOP_ITEMS = ['Program', 'Ground_Stop'];
const GROUND_DELAY_ITEMS = ['Ground_Delay'];
const IGNORED_LISTS = new Set([
	'Arrival_Departure_Delay_List',
	'Airspace_Flow_List',
	'Airport_Closure_List',
]);

class FeedFormatError extends Error {}
class UnrecognizedStructure extends Error {}

const parser = new XMLParser({
	ignoreAttributes: true,
	// The XML declaration and processing instructions carry no feed data; drop them everywhere.
	ignoreDeclaration: true,
	ignorePiTags: true,
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

export function parseFeed(xml: string, structure: StructureCheck): FeedParseResult {
	const wellFormed = XMLValidator.validate(xml);
	if (wellFormed !== true) {
		return parseError(`XML not well formed: ${wellFormed.err.msg} (line ${wellFormed.err.line})`);
	}
	let tree: unknown;
	try {
		tree = parser.parse(xml);
	} catch (error) {
		return parseError(`XML parser rejected the document: ${String(error)}`);
	}
	const document = documentSchema.safeParse(tree);
	const roots = document.success ? Object.keys(document.data) : [];
	if (roots.length !== 1 || roots[0] !== ROOT) {
		return parseError(`expected exactly one ${ROOT} root, found [${roots.join(', ')}]`);
	}
	const unknown = structure === 'checked' ? unknownRootChildren(document.data?.[ROOT]) : [];
	if (unknown.length > 0) {
		return {
			ok: false,
			reason: 'unrecognized_structure',
			detail: `${ROOT} holds element(s) the feed has never carried: ${unknown.join(', ')}`,
		};
	}
	const root = rootSchema.safeParse(tree);
	if (!root.success) return parseError(`not an ${ROOT} document: ${z.prettifyError(root.error)}`);
	const { Update_Time: updateTimeText, Delay_type: blocks = [] } = root.data[ROOT];
	for (const list of PROGRAM_BLOCK_NAMES.keys()) {
		const inBlocks = blocks.filter((block) => block !== '' && Object.hasOwn(block, list)).length;
		if (countKey(tree, list) !== inBlocks) {
			return parseError(`${list} found outside a Delay_type block`);
		}
	}
	const updateTime = parseFeedUpdateTime(updateTimeText);
	if (updateTime === null) return parseError(`unparseable Update_Time "${updateTimeText}"`);
	try {
		const events: ProgramEvent[] = [];
		const otherDelayTypes: OtherDelayType[] = [];
		for (const block of blocks) {
			const contents = block === '' ? {} : block;
			if (structure === 'checked') requireCountedList(contents);
			readDelayType(contents, events, otherDelayTypes);
		}
		return { ok: true, feed: { updateTime, events, otherDelayTypes } };
	} catch (error) {
		if (error instanceof FeedFormatError) return parseError(error.message);
		if (error instanceof UnrecognizedStructure)
			return { ok: false, reason: 'unrecognized_structure', detail: error.message };
		throw error;
	}
}

function parseError(detail: string): FeedParseResult {
	return { ok: false, reason: 'parse_error', detail };
}

/** Root children outside FAA_ROOT_CHILDREN. An empty root (text only) has none. */
function unknownRootChildren(root: unknown): string[] {
	if (typeof root !== 'object' || root === null) return [];
	return Object.keys(root).filter((name) => !FAA_ROOT_CHILDREN.has(name));
}

/**
 * A block named for a counted program must hold exactly one of that program's list and nothing
 * else. A renamed list under a counted Name would otherwise be recorded as `unrecognized` and
 * the round read as an all-clear. A repeated list parses to an array. Blocks with other names
 * are left to readDelayType.
 */
function requireCountedList(block: Record<string, unknown>): void {
	const names = [block.Name].flat().filter((name) => typeof name === 'string');
	const lists = Object.keys(block).filter((key) => key !== 'Name');
	for (const [list, countedName] of PROGRAM_BLOCK_NAMES) {
		if (!names.includes(countedName)) continue;
		const found = lists.flatMap((key) => {
			const value = block[key];
			return Array.isArray(value) ? value.map(() => key) : [key];
		});
		if (!(found.length === 1 && found[0] === list)) {
			throw new UnrecognizedStructure(
				`a "${countedName}" block must hold exactly one ${list}, found [${found.join(', ')}]`,
			);
		}
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
		const expectedName = PROGRAM_BLOCK_NAMES.get(element);
		// A counted list needs exactly one Name, the right one: absent, repeated or other fails.
		if (expectedName !== undefined && block.Name !== expectedName) {
			throw new FeedFormatError(
				`${element} needs one Name "${expectedName}", found ${JSON.stringify(block.Name ?? null)}`,
			);
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
