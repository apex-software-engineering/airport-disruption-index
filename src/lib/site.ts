export const site = {
	name: 'Airport Disruption Index',
	description:
		'A settlement-grade index of FAA ground stops and ground delay programs at US airports.',
	footer: 'An Apex Software Engineering index',
	repoUrl: 'https://github.com/apex-software-engineering/airport-disruption-index',
} as const;

/** The shell commands that get the source onto a machine, shown before every reproduce command. */
export const cloneCommand = `git clone ${site.repoUrl} && cd airport-disruption-index && npm ci`;
