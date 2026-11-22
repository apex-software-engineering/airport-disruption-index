/** Scale helpers shared by the charts. */

/** Smallest 1/2/2.5/5 × 10^k at or above `value`, so the top gridline is a round number. */
export function niceCeiling(value: number): number {
	if (value <= 0) return 60;
	const magnitude = 10 ** Math.floor(Math.log10(value));
	const step = [1, 2, 2.5, 5, 10].find((m) => m * magnitude >= value);
	if (step === undefined) throw new Error(`no nice ceiling for ${value}`);
	return step * magnitude;
}

/** Gridlines at zero, the top and, where it lands on a whole number, the middle. */
export function ticksTo(top: number): number[] {
	return top % 2 === 0 ? [0, top / 2, top] : [0, top];
}
