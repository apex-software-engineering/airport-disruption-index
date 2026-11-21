import type { Metadata } from 'next';
import Link from 'next/link';

import { PageTitle, Section } from '@/components/ui';
import { contactEmail, site } from '@/lib/site';

export const metadata: Metadata = { title: 'Contact' };

export default function ContactPage() {
	return (
		<>
			<PageTitle title='Contact' lede='The index is operated by Apex Software Engineering LLC.' />
			<Section title='Email'>
				<p>
					<a href={`mailto:${contactEmail}`}>{contactEmail}</a>
				</p>
			</Section>
			<Section title='Incidents and corrections'>
				<p className='text-sm'>
					Incidents and correction prints are published on the{' '}
					<Link href='/incidents'>incidents page</Link> and discussed in{' '}
					<a href={site.incidentIssuesUrl}>issues labelled incident</a> in the public repository,
					where anyone can open an issue to report a problem.
				</p>
			</Section>
		</>
	);
}
