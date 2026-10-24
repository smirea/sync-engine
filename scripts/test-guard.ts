/**
 * Preloaded by `bun test`. In procrastimate, a shell with a cloud environment loaded once filled a shared database
 * with test users. Refuse to start unless the database is local.
 */
const url = process.env.DATABASE_URL;
if (url) {
	const host = URL.parse(url)?.hostname;
	if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
		console.error(
			`Refusing to run tests against a non-local DATABASE_URL (${host ?? url}). Unset it or point it at a local database.`,
		);
		process.exit(1);
	}
}
