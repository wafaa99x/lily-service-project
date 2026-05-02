// server.js
import crypto from 'crypto';
import express from 'express';

const app = express();

app.use(express.json());
app.use(express.static('.'));

const TOKEN_TTL_SECONDS = 2 * 60 * 60;
const LOGIN_WINDOW_MS = Number(process.env.LOGIN_WINDOW_MS || 15 * 60 * 1000);
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS || 5);
const LOGIN_LOCKOUT_MS = Number(process.env.LOGIN_LOCKOUT_MS || 15 * 60 * 1000);
const SHOPIFY_ORDER_SYNC_INTERVAL_MS = Number(process.env.SHOPIFY_ORDER_SYNC_INTERVAL_MS || 0.25 * 60 * 1000);
const ALLOWED_TABLES = new Set(['products', 'bookings', 'blocked_slots', 'delivery_zones']);
const ALLOWED_FILTER_OPS = new Set(['eq', 'gte', 'lte', 'in', 'ilike', 'not']);

// In-memory login protection. For multi-instance deployments, use shared storage (Redis).
const loginSecurityState = new Map();

function cleanBaseUrl(value) {
	return String(value || '').replace(/\/+$/, '');
}

function getEnvOrThrow(name) {
	const value = String(process.env[name] || '').trim();
	if (!value) throw new Error(`Missing ${name}`);
	return value;
}

function base64UrlEncode(input) {
	return Buffer.from(input)
		.toString('base64')
		.replace(/=/g, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_');
}

function base64UrlDecode(input) {
	const normalized = String(input).replace(/-/g, '+').replace(/_/g, '/');
	const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
	return Buffer.from(padded, 'base64').toString('utf8');
}

function signJwt(payload, secret, expiresInSeconds) {
	const header = { alg: 'HS256', typ: 'JWT' };
	const now = Math.floor(Date.now() / 1000);
	const body = { ...payload, iat: now, exp: now + expiresInSeconds };
	const headerPart = base64UrlEncode(JSON.stringify(header));
	const payloadPart = base64UrlEncode(JSON.stringify(body));
	const data = `${headerPart}.${payloadPart}`;
	const signature = crypto
		.createHmac('sha256', secret)
		.update(data)
		.digest('base64')
		.replace(/=/g, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_');
	return `${data}.${signature}`;
}

function verifyJwt(token, secret) {
	const parts = String(token || '').split('.');
	if (parts.length !== 3) throw new Error('Invalid token');
	const [headerPart, payloadPart, signaturePart] = parts;
	const data = `${headerPart}.${payloadPart}`;
	const expected = crypto
		.createHmac('sha256', secret)
		.update(data)
		.digest('base64')
		.replace(/=/g, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_');
	if (!crypto.timingSafeEqual(Buffer.from(signaturePart), Buffer.from(expected))) {
		throw new Error('Invalid token signature');
	}
	const payload = JSON.parse(base64UrlDecode(payloadPart));
	const now = Math.floor(Date.now() / 1000);
	if (!payload.exp || payload.exp < now) throw new Error('Token expired');
	return payload;
}

function getAuthToken(req) {
	const header = String(req.headers.authorization || '');
	if (!header.startsWith('Bearer ')) return null;
	return header.slice('Bearer '.length).trim();
}

function getClientIp(req) {
	const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
	if (forwarded) return forwarded;
	return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

function getLoginState(ip) {
	const now = Date.now();
	const existing = loginSecurityState.get(ip);
	if (!existing) {
		const fresh = { attempts: 0, firstAttemptAt: now, lockUntil: 0 };
		loginSecurityState.set(ip, fresh);
		return fresh;
	}

	if (existing.lockUntil && existing.lockUntil <= now) {
		existing.lockUntil = 0;
		existing.attempts = 0;
		existing.firstAttemptAt = now;
	}
	if (now - existing.firstAttemptAt > LOGIN_WINDOW_MS) {
		existing.attempts = 0;
		existing.firstAttemptAt = now;
	}
	return existing;
}

function getLockoutRemainingMs(ip) {
	const state = getLoginState(ip);
	const now = Date.now();
	if (!state.lockUntil || state.lockUntil <= now) return 0;
	return state.lockUntil - now;
}

function recordFailedLogin(ip) {
	const state = getLoginState(ip);
	const now = Date.now();
	if (now - state.firstAttemptAt > LOGIN_WINDOW_MS) {
		state.firstAttemptAt = now;
		state.attempts = 0;
	}
	state.attempts += 1;
	if (state.attempts >= LOGIN_MAX_ATTEMPTS) {
		state.lockUntil = now + LOGIN_LOCKOUT_MS;
	}
	loginSecurityState.set(ip, state);
	return state;
}

function clearLoginFailures(ip) {
	loginSecurityState.delete(ip);
}

function requireAuth(req, res, next) {
	try {
		const secret = getEnvOrThrow('ADMIN_JWT_SECRET');
		const token = getAuthToken(req);
		if (!token) return res.status(401).json({ error: 'Missing auth token' });
		const payload = verifyJwt(token, secret);
		req.admin = payload;
		next();
	} catch (error) {
		res.status(401).json({ error: error.message || 'Unauthorized' });
	}
}

async function invokeSupabaseSync(functionName, payload) {
	const supabaseUrl = cleanBaseUrl(getEnvOrThrow('SUPABASE_URL'));
	const supabaseKey = getEnvOrThrow('SUPABASE_SERVICE_ROLE_KEY');

	const response = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			apikey: supabaseKey,
			Authorization: `Bearer ${supabaseKey}`
		},
		body: JSON.stringify(payload)
	});

	const json = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(json?.error || `${functionName} failed (${response.status})`);
	}
	return json;
}

function resolveShopifyDomain(requestDomain) {
	return String(requestDomain || process.env.SHOPIFY_STORE_DOMAIN || '').trim();
}

function resolveShopifyToken() {
	return String(process.env.SHOPIFY_ADMIN_API_TOKEN || '').trim();
}

async function syncShopifyOrdersOnce(domainOverride) {
	const domain = resolveShopifyDomain(domainOverride);
	const token = resolveShopifyToken();

	if (!domain) {
		throw new Error('Missing Shopify domain');
	}
	if (!token) {
		throw new Error('Missing SHOPIFY_ADMIN_API_TOKEN');
	}

	return invokeSupabaseSync('shopify-orders-sync', { domain, token });
}

function applyFilter(url, filter) {
	const op = String(filter?.op || '');
	const column = String(filter?.column || '');
	if (!ALLOWED_FILTER_OPS.has(op)) throw new Error(`Unsupported filter op: ${op}`);
	if (!column) throw new Error('Filter column is required');

	if (op === 'eq') {
		url.searchParams.append(column, `eq.${filter.value}`);
		return;
	}
	if (op === 'gte') {
		url.searchParams.append(column, `gte.${filter.value}`);
		return;
	}
	if (op === 'lte') {
		url.searchParams.append(column, `lte.${filter.value}`);
		return;
	}
	if (op === 'in') {
		const values = Array.isArray(filter.values) ? filter.values : [];
		const escaped = values.map(v => `"${String(v).replace(/"/g, '\\"')}"`).join(',');
		url.searchParams.append(column, `in.(${escaped})`);
		return;
	}
	if (op === 'ilike') {
		url.searchParams.append(column, `ilike.${filter.pattern}`);
		return;
	}
	if (op === 'not') {
		url.searchParams.append(column, `not.${filter.operator}.${filter.value}`);
	}
}

async function executeDbQuery(query) {
	const supabaseUrl = cleanBaseUrl(getEnvOrThrow('SUPABASE_URL'));
	const supabaseKey = getEnvOrThrow('SUPABASE_SERVICE_ROLE_KEY');
	const table = String(query?.table || '');
	if (!ALLOWED_TABLES.has(table)) throw new Error('Table not allowed');

	const op = String(query?.op || 'select');
	const headers = {
		apikey: supabaseKey,
		Authorization: `Bearer ${supabaseKey}`,
		'Content-Type': 'application/json'
	};

	const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
	let method = 'GET';
	let body;

	if (op === 'select') {
		url.searchParams.set('select', query?.select || '*');
		(query?.filters || []).forEach(f => applyFilter(url, f));
		(query?.orders || []).forEach(o => {
			url.searchParams.append('order', `${o.column}.${o.ascending === false ? 'desc' : 'asc'}`);
		});
		if (typeof query?.limit === 'number') {
			url.searchParams.set('limit', String(query.limit));
		}
		if (query?.count === 'exact') {
			headers.Prefer = 'count=exact';
		}
	} else if (op === 'insert') {
		method = 'POST';
		headers.Prefer = 'return=representation';
		body = JSON.stringify(query?.values ?? null);
	} else if (op === 'update') {
		method = 'PATCH';
		headers.Prefer = 'return=representation';
		(query?.filters || []).forEach(f => applyFilter(url, f));
		body = JSON.stringify(query?.values ?? null);
	} else if (op === 'delete') {
		method = 'DELETE';
		headers.Prefer = 'return=representation';
		(query?.filters || []).forEach(f => applyFilter(url, f));
	} else {
		throw new Error(`Unsupported operation: ${op}`);
	}

	const response = await fetch(url.toString(), { method, headers, body });
	const data = await response.json().catch(() => null);
	if (!response.ok) {
		throw new Error(data?.message || data?.error || `DB query failed (${response.status})`);
	}

	let count = null;
	const contentRange = response.headers.get('content-range');
	if (contentRange && contentRange.includes('/')) {
		const total = contentRange.split('/')[1];
		if (total !== '*') count = Number(total);
	}

	return { data, count, error: null };
}

app.post('/api/auth/login', (req, res) => {
	try {
		const ip = getClientIp(req);
		const remainingMs = getLockoutRemainingMs(ip);
		if (remainingMs > 0) {
			const retryAfterSeconds = Math.ceil(remainingMs / 1000);
			res.setHeader('Retry-After', String(retryAfterSeconds));
			return res.status(429).json({
				error: `Too many failed attempts. Try again in ${retryAfterSeconds} seconds.`,
				retryAfterSeconds
			});
		}

		const adminPassword = getEnvOrThrow('ADMIN_PASSWORD');
		const jwtSecret = getEnvOrThrow('ADMIN_JWT_SECRET');
		const provided = String(req.body?.password || '');
		if (!provided || provided !== adminPassword) {
			const state = recordFailedLogin(ip);
			if (state.lockUntil > Date.now()) {
				const lockRemainingSec = Math.ceil((state.lockUntil - Date.now()) / 1000);
				res.setHeader('Retry-After', String(lockRemainingSec));
				return res.status(429).json({
					error: `Too many failed attempts. Try again in ${lockRemainingSec} seconds.`,
					retryAfterSeconds: lockRemainingSec
				});
			}
			const attemptsLeft = Math.max(0, LOGIN_MAX_ATTEMPTS - state.attempts);
			return res.status(401).json({
				error: 'Invalid credentials',
				attemptsLeft
			});
		}

		clearLoginFailures(ip);
		const token = signJwt({ role: 'admin' }, jwtSecret, TOKEN_TTL_SECONDS);
		return res.json({ token, expiresIn: TOKEN_TTL_SECONDS });
	} catch (error) {
		return res.status(500).json({ error: error.message || 'Login failed' });
	}
});

app.get('/api/auth/me', requireAuth, (req, res) => {
	res.json({ ok: true, role: req.admin?.role || 'admin' });
});

app.post('/api/auth/logout', (_req, res) => {
	res.json({ ok: true });
});

app.post('/api/admin/db', requireAuth, async (req, res) => {
	try {
		const result = await executeDbQuery(req.body || {});
		res.json(result);
	} catch (error) {
		res.status(400).json({ data: null, count: null, error: error.message || 'Query failed' });
	}
});

app.post('/api/shopify/sync-products', requireAuth, async (req, res) => {
	try {
		const domain = resolveShopifyDomain(req.body?.domain);
		const token = resolveShopifyToken();

		if (!domain) {
			return res.status(400).json({ error: 'Missing Shopify domain' });
		}
		if (!token) {
			return res.status(500).json({ error: 'Missing SHOPIFY_ADMIN_API_TOKEN' });
		}

		const data = await invokeSupabaseSync('shopify-products-sync', { domain, token });
		res.json(data);
	} catch (error) {
		res.status(500).json({ error: error.message || 'Product sync failed' });
	}
});

app.post('/api/shopify/sync-orders', requireAuth, async (req, res) => {
	try {
		const data = await syncShopifyOrdersOnce(req.body?.domain);
		res.json(data);
	} catch (error) {
		res.status(500).json({ error: error.message || 'Order sync failed' });
	}
});

let orderSyncTimer = null;
let orderSyncInFlight = false;

async function runBackgroundOrderSync() {
	if (orderSyncInFlight) return;
	const domain = resolveShopifyDomain();
	if (!domain || !resolveShopifyToken()) return;

	orderSyncInFlight = true;
	try {
		await syncShopifyOrdersOnce(domain);
		console.log('[orders] background sync complete');
	} catch (error) {
		console.error('[orders] background sync failed:', error.message || error);
	} finally {
		orderSyncInFlight = false;
	}
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
	console.log(`Server running on ${port}`);
	if (SHOPIFY_ORDER_SYNC_INTERVAL_MS > 0) {
		runBackgroundOrderSync();
		orderSyncTimer = setInterval(runBackgroundOrderSync, SHOPIFY_ORDER_SYNC_INTERVAL_MS);
	}
});