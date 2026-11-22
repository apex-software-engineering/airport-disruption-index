import { INDICATIVE_UNPUBLISHED, indicativeSeriesPublished } from '@/lib/index/indicative';
import { parseUtcDate } from '@/lib/index/time';
import { CACHE, json, problem } from '@/server/http';
import { storeFromEnv } from '@/server/storage';
import { indicativeDayView } from '@/server/views';

export const dynamic = 'force-dynamic';

/**
 * The indicative ET print of a day (design §4): never a settlement value. A frozen print never
 * changes, so it caches forever; a day not frozen yet says when it will be.
 */
export async function GET(_request: Request, context: { params: Promise<{ date: string }> }) {
	if (!indicativeSeriesPublished()) return problem(404, INDICATIVE_UNPUBLISHED);
	const { date } = await context.params;
	if (parseUtcDate(date) === null) return problem(400, `invalid date ${date}`);
	const view = await indicativeDayView(storeFromEnv(), date);
	switch (view.status) {
		case 'frozen':
			return json(view.body, CACHE.immutable);
		case 'pending':
			return json(view.body, CACHE.live, 404);
		case 'none':
			switch (view.reason) {
				case 'before_series':
					return problem(404, `${date} is before the indicative series starts`);
				case 'withdrawn':
					return problem(404, `${date} was not frozen before its release was withdrawn`);
				case 'series_ended':
					return json(
						{
							error: `${date} has no indicative day: the indicative series ends before v2 takes effect`,
							see: `/api/v1/days/${date}`,
						},
						CACHE.daily,
						404,
					);
			}
	}
}
