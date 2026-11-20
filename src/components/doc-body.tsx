import { renderDoc, type DocName } from './docs';

/** A docs/*.md file rendered as the page body. The markdown is ours, from the repo. */
export async function DocBody({ name }: { name: DocName }) {
	const html = await renderDoc(name);
	return <article className='prose-doc' dangerouslySetInnerHTML={{ __html: html }} />;
}
