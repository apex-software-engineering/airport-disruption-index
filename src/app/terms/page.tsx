import type { Metadata } from 'next';

import { DocBody } from '@/components/doc-body';

export const metadata: Metadata = { title: 'Terms of use' };

export default function TermsPage() {
	return <DocBody name='terms' />;
}
