import { site } from '@/lib/site';

export default function HomePage() {
	return (
		<section className='mx-auto max-w-3xl px-6 py-16'>
			<h1 className='text-3xl font-semibold tracking-tight'>{site.name}</h1>
			<p className='mt-4 text-neutral-600'>{site.description}</p>
		</section>
	);
}
