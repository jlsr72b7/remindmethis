import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
	log: [
		{ emit: 'event', level: 'query' },
		{ emit: 'event', level: 'error' },
		{ emit: 'event', level: 'warn' },
	],
});

const sanitizeForLog = (value: unknown, depth = 0): unknown => {
	if (value === null || value === undefined) {
		return value;
	}

	if (depth > 3) {
		return '[MaxDepth]';
	}

	if (value instanceof Date) {
		return value.toISOString();
	}

	if (Array.isArray(value)) {
		return value.map((entry) => sanitizeForLog(entry, depth + 1));
	}

	if (typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, sanitizeForLog(entry, depth + 1)]),
		);
	}

	return value;
};

prisma.$on('query', (event) => {
	console.log('[prisma:query]', {
		timestamp: new Date().toISOString(),
		durationMs: event.duration,
		query: event.query,
		params: event.params,
		target: event.target,
	});
});

prisma.$on('error', (event) => {
	console.error('[prisma:error]', {
		timestamp: new Date().toISOString(),
		message: event.message,
		target: event.target,
	});
});

prisma.$on('warn', (event) => {
	console.warn('[prisma:warn]', {
		timestamp: new Date().toISOString(),
		message: event.message,
		target: event.target,
	});
});

prisma.$use(async (params, next) => {
	const startedAt = Date.now();
	console.log('[prisma:request]', {
		timestamp: new Date().toISOString(),
		model: params.model,
		action: params.action,
		args: sanitizeForLog(params.args),
	});

	try {
		const result = await next(params);
		console.log('[prisma:response]', {
			timestamp: new Date().toISOString(),
			model: params.model,
			action: params.action,
			durationMs: Date.now() - startedAt,
			result: sanitizeForLog(result),
		});
		return result;
	} catch (error) {
		console.error('[prisma:response:error]', {
			timestamp: new Date().toISOString(),
			model: params.model,
			action: params.action,
			durationMs: Date.now() - startedAt,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
});
