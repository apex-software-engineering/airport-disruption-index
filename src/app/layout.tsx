import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { site } from '@/lib/site';

import './globals.css';

export const metadata: Metadata = {
	title: site.name,
	description: site.description,
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
	return (
		<html lang='en'>
			<body className='flex min-h-dvh flex-col bg-white text-neutral-900 antialiased'>
				<main className='flex-1'>{children}</main>
				<footer className='border-t border-neutral-200 px-6 py-4 text-sm text-neutral-500'>
					{site.footer}
				</footer>
			</body>
		</html>
	);
}
