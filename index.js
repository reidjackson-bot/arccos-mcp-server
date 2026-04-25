// File: index.js
//
// Arccos Golf MCP Server
// Wraps the Arccos dashboard REST API (api.arccosgolf.com).
//
// Auth: two-step token exchange, fully automated.
//   1. accessKey + userId → POST authentication.arccosgolf.com/tokens → JWT
//   2. JWT (3-hour lifetime) used as `Authorization: Bearer: <jwt>` on api calls
//
// Server caches the JWT in memory and auto-refreshes ~60s before expiry,
// or on 401 from the API. The accessKey is long-lived (does not rotate
// unless the user explicitly logs out everywhere or changes password).
//
// To get an accessKey, run `npm run login` (or call POST /accessKeys with
// email + password directly). Once obtained, set ARCCOS_ACCESS_KEY in env.
//
// Env vars:
//   ARCCOS_USER_ID    — your user id (visible in dashboard URL path)
//   ARCCOS_ACCESS_KEY — long-lived 40-char hex from /accessKeys login
//
// Endpoints reverse-engineered from:
//   - dashboard.arccosgolf.com (auth flow)
//   - old.dashboard.arccosgolf.com (REST data flow)

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = parseInt(process.env.PORT || '3000', 10);
const ARCCOS_USER_ID = process.env.ARCCOS_USER_ID;
const ARCCOS_ACCESS_KEY = process.env.ARCCOS_ACCESS_KEY;
const ARCCOS_API_BASE = 'https://api.arccosgolf.com';
const ARCCOS_AUTH_BASE = 'https://authentication.arccosgolf.com';

if (!ARCCOS_USER_ID) {
  console.error('Missing ARCCOS_USER_ID environment variable');
  process.exit(1);
}
if (!ARCCOS_ACCESS_KEY) {
  console.error('Missing ARCCOS_ACCESS_KEY environment variable');
  console.error('To get one: POST https://authentication.arccosgolf.com/accessKeys with {email, password, signedInByFacebook:"F"}');
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────
// Token cache + refresh
// ────────────────────────────────────────────────────────────────
let cachedToken = null; // { jwt, expiresAt: Date }

function jwtExpiry(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
    return payload.exp ? new Date(payload.exp * 1000) : null;
  } catch (_e) {
    return null;
  }
}

async function fetchFreshToken() {
  const response = await fetch(`${ARCCOS_AUTH_BASE}/tokens`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json;charset=utf-8',
      'Origin': 'https://dashboard.arccosgolf.com',
      'Referer': 'https://dashboard.arccosgolf.com/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({
      accessKey: ARCCOS_ACCESS_KEY,
      userId: ARCCOS_USER_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${text.substring(0, 500)}`);
  }

  const data = await response.json();
  // Response shape: { token: "<jwt>", ... } — exact field name confirmed empirically.
  // We accept a few common shapes defensively in case Arccos varies the field.
  const jwt = data.token || data.access_token || data.accessToken || data.jwt;
  if (!jwt) {
    throw new Error(`Token refresh response missing JWT field. Got keys: ${Object.keys(data).join(', ')}`);
  }

  const expiresAt = jwtExpiry(jwt) || new Date(Date.now() + 60 * 60 * 1000); // fall back to 1hr
  cachedToken = { jwt, expiresAt };
  console.log(`[Arccos MCP] Refreshed JWT. Expires ${expiresAt.toISOString()}.`);
  return cachedToken;
}

async function getValidToken() {
  const REFRESH_THRESHOLD_MS = 60 * 1000; // refresh if <60s left
  if (
    cachedToken &&
    cachedToken.expiresAt.getTime() - Date.now() > REFRESH_THRESHOLD_MS
  ) {
    return cachedToken;
  }
  return fetchFreshToken();
}

// ────────────────────────────────────────────────────────────────
// Club type lookup table
// Mapping confirmed against a real 14-club bag:
//   1=Driver, 14=3W (Titleist TSR3), 26=Utility iron (U505),
//   5–11=4i thru PW, 12=Putter, 47=50° wedge, 51=54° wedge, 55=58° wedge.
//
// Wedges are encoded as `clubType = loft − 3` (so 47 → 50°, 51 → 54°, etc).
// We handle wedges programmatically via this offset rather than a static map,
// which means any wedge loft Reid (or anyone) carries gets a correct label.
// ────────────────────────────────────────────────────────────────
const CLUB_TYPE_MAP = {
  1: 'Driver',
  // Fairway woods
  14: '3 Wood',
  19: '5 Wood',
  20: '7 Wood',
  21: '9 Wood',
  // Hybrids (TBD — not seen yet, codes are guesses pending real data)
  22: '2 Hybrid',
  23: '3 Hybrid',
  24: '4 Hybrid',
  25: '5 Hybrid',
  // Utility / driving irons
  26: 'Utility Iron',
  // Numbered irons (confirmed)
  4: '3 Iron',
  5: '4 Iron',
  6: '5 Iron',
  7: '6 Iron',
  8: '7 Iron',
  9: '8 Iron',
  10: '9 Iron',
  11: 'Pitching Wedge',
  // Putter
  12: 'Putter',
};

function clubTypeName(code) {
  if (CLUB_TYPE_MAP[code]) return CLUB_TYPE_MAP[code];
  // Wedge loft encoding: clubType in roughly 40–65 → loft = clubType + 3.
  // Covers gap/sand/lob and any custom loft.
  if (typeof code === 'number' && code >= 40 && code <= 65) {
    return `${code + 3}° Wedge`;
  }
  return `Unknown (clubType=${code})`;
}

// ────────────────────────────────────────────────────────────────
// HTTP helper — auto-refreshes the JWT, retries once on 401.
// Mirrors dashboard headers for stability.
// ────────────────────────────────────────────────────────────────
async function arccosGet(path, queryParams = {}) {
  const url = new URL(ARCCOS_API_BASE + path);
  for (const [k, v] of Object.entries(queryParams)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  async function attempt(token) {
    return fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json;charset=utf-8',
        // Wire format is literally `Bearer: <jwt>` (with colon) — verified from
        // dashboard.arccosgolf.com network capture. Replicating verbatim.
        'Authorization': `Bearer: ${token.jwt}`,
        'Origin': 'https://dashboard.arccosgolf.com',
        'Referer': 'https://dashboard.arccosgolf.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      },
    });
  }

  let token = await getValidToken();
  let response = await attempt(token);

  // If we get 401 anyway (e.g. server-side rotation, clock skew), force a
  // refresh and retry once. Never loop more than once.
  if (response.status === 401) {
    console.log('[Arccos MCP] Got 401, forcing token refresh and retrying.');
    cachedToken = null;
    token = await getValidToken();
    response = await attempt(token);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Arccos API error (${response.status}) at ${path}: ${text.substring(0, 500)}`);
  }

  // Some endpoints (rare) may return non-JSON; guard the parse.
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    const text = await response.text();
    return { _nonJson: true, raw: text.substring(0, 1000) };
  }

  return response.json();
}

function asJson(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

// ────────────────────────────────────────────────────────────────
// MCP Server
// ────────────────────────────────────────────────────────────────
function createServer() {
  const server = new McpServer({
    name: 'arccos-mcp',
    version: '0.3.1',
  });

  // ─── Profile ───
  server.tool(
    'arccos_get_profile',
    'Get user profile: name, email, handicap, home course, current bag reference, ball preference.',
    {},
    async () => {
      const data = await arccosGet(`/users/${ARCCOS_USER_ID}`, { email: '' });
      return asJson(data);
    }
  );

  // ─── Skill Handicaps ───
  server.tool(
    'arccos_get_skill_handicaps',
    'Get latest skill handicaps broken down by drive, approach, chip, sand, and putt — plus the rounds used to compute them.',
    {},
    async () => {
      const data = await arccosGet(`/users/${ARCCOS_USER_ID}/handicaps/latest`);
      return asJson(data);
    }
  );

  // ─── Player Summary (lightweight) ───
  server.tool(
    'arccos_get_player_summary',
    'Get a quick stats summary: total handicap, rounds, holes played, shots played, and SGA settings (rolling round window, goal handicap).',
    {},
    async () => {
      const data = await arccosGet(`/sga/playerProfile/${ARCCOS_USER_ID}`);
      return asJson(data);
    }
  );

  // ─── Tour Analytics Summary ───
  server.tool(
    'arccos_get_tour_summary',
    'Get aggregated stats across all rounds: drive distance/accuracy, GIR, scrambling, putts per round, sand/chip performance.',
    {
      isDriverHandicap: z.boolean().optional().describe('If true, request driver-handicap-flavored stats. Default false.'),
    },
    async ({ isDriverHandicap }) => {
      const data = await arccosGet(`/users/${ARCCOS_USER_ID}/tourAnalyticsSummary`, {
        isDriverHandicap: isDriverHandicap ? 'T' : 'F',
      });
      return asJson(data);
    }
  );

  // ─── Rounds list ───
  server.tool(
    'arccos_get_rounds',
    'List rounds with pagination. Each round includes id, course id, start/end times, hole count, shot count, and round type.',
    {
      offset: z.number().int().nonnegative().optional().describe('Pagination offset (default 0)'),
      limit: z.number().int().positive().max(100).optional().describe('Page size (default 10, max 100)'),
      courseId: z.string().optional().describe('Filter by course id (numeric, as string). Optional.'),
      roundType: z.enum(['flagship', 'driver']).optional().describe('Round type filter. Default "flagship".'),
    },
    async ({ offset, limit, courseId, roundType }) => {
      const data = await arccosGet(`/users/${ARCCOS_USER_ID}/rounds`, {
        offSet: offset ?? 0,           // note: Arccos API uses camelCase "offSet"
        limit: limit ?? 10,
        courseId: courseId ?? '',
        roundType: roundType ?? 'flagship',
      });
      return asJson(data);
    }
  );

  // ─── Dashboard Analysis (single round OR rolling window) ───
  server.tool(
    'arccos_get_dashboard_analysis',
    'Get the full strokes-gained breakdown — overall, driving, approach, short game, putting. Two modes: pass `roundId` for a single round, or `noOfRounds` for a rolling window across the most recent N rounds (with trend analysis).',
    {
      roundId: z.union([z.number().int(), z.string()]).optional().describe('Single round ID. Mutually exclusive with noOfRounds.'),
      noOfRounds: z.number().int().positive().max(50).optional().describe('Rolling window size (most recent N rounds). Mutually exclusive with roundId. Defaults to 5 if neither is provided.'),
      goalHcp: z.number().optional().describe('Goal handicap baseline for SG calculation (default 0).'),
    },
    async ({ roundId, noOfRounds, goalHcp }) => {
      if (roundId !== undefined && noOfRounds !== undefined) {
        throw new Error('Pass either roundId OR noOfRounds, not both.');
      }
      const params = { goalHcp: goalHcp ?? 0 };
      if (roundId !== undefined) {
        params.roundId = roundId;
      } else {
        params.noOfRounds = noOfRounds ?? 5;
      }
      const data = await arccosGet(`/sga/getDashboardAnalysis/${ARCCOS_USER_ID}`, params);
      return asJson(data);
    }
  );

  // ─── Round metadata (thin) ───
  server.tool(
    'arccos_get_round_metadata',
    'Get device/app metadata for a specific round (hardware, OS, app version, shot-tracking flag). Mostly diagnostic.',
    {
      roundId: z.union([z.number().int(), z.string()]).describe('Round ID'),
    },
    async ({ roundId }) => {
      const data = await arccosGet(`/analytics/${roundId}`);
      return asJson(data);
    }
  );

  // ─── Clubs (current bag) ───
  server.tool(
    'arccos_get_clubs',
    'Get the current bag — paired and unpaired clubs with sensor IDs, make, model, and a basic smart-distance summary in meters.',
    {
      unpairedOnly: z.boolean().optional().describe('Return only unpaired clubs. Default false.'),
      offset: z.number().int().nonnegative().optional().describe('Pagination offset (default 0)'),
      limit: z.number().int().positive().max(50).optional().describe('Page size (default 20)'),
    },
    async ({ unpairedOnly, offset, limit }) => {
      const data = await arccosGet(`/v6/users/${ARCCOS_USER_ID}/clubs`, {
        unpaired_only: unpairedOnly ? 'true' : 'false',
        limit: limit ?? 20,
        offset: offset ?? 0,
      });
      // Enrich each club with a human-readable type label.
      try {
        if (data?.clubs?.paired) {
          data.clubs.paired = data.clubs.paired.map((c) => ({
            ...c,
            clubTypeName: clubTypeName(c.clubType),
          }));
        }
        if (data?.clubs?.unpaired) {
          data.clubs.unpaired = data.clubs.unpaired.map((c) => ({
            ...c,
            clubTypeName: clubTypeName(c.clubType),
          }));
        }
      } catch (_e) { /* leave untouched */ }
      return asJson(data);
    }
  );

  // ─── Smart distances by club ───
  server.tool(
    'arccos_get_club_distances',
    'Get smart-distance stats per club: smart distance, normalized distance, terrain breakdown (tee/fairway/rough/sand with diffs), shot count, GIR %, longest, range. The goldmine for club-distance gapping.',
    {
      numberOfShots: z.number().int().positive().max(500).optional().describe('Sample size for the smart-distance calculation (default 100).'),
      units: z.enum(['IMPERIAL', 'METRIC']).optional().describe('Output units. Default IMPERIAL.'),
    },
    async ({ numberOfShots, units }) => {
      const data = await arccosGet(`/v4/clubs/user/${ARCCOS_USER_ID}/smart-distances`, {
        numberOfShots: numberOfShots ?? 100,
        units: units ?? 'IMPERIAL',
      });
      // Enrich each club entry with human-readable name where we can.
      // Note: this endpoint returns clubId only, not clubType, so the label
      // requires a join with /v6/.../clubs. We surface a hint in the response.
      try {
        if (Array.isArray(data?.clubs)) {
          data._note = 'clubId here joins to /v6/.../clubs; call arccos_get_clubs for clubTypeName.';
        }
      } catch (_e) {}
      return asJson(data);
    }
  );

  return server;
}

// ────────────────────────────────────────────────────────────────
// Express app — /mcp (POST), /health (GET)
// ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'arccos-mcp',
    version: '0.3.1',
    userId: ARCCOS_USER_ID ? `${ARCCOS_USER_ID.substring(0, 8)}…` : null,
    auth: {
      mode: 'auto-refresh',
      hasCachedToken: cachedToken !== null,
      tokenExpiresAt: cachedToken ? cachedToken.expiresAt.toISOString() : null,
      minutesUntilExpiry: cachedToken
        ? Math.round((cachedToken.expiresAt - new Date()) / 60000)
        : null,
    },
    timestamp: new Date().toISOString(),
  });
});

app.post('/mcp', async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('[MCP] Error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

app.get('/mcp', (_req, res) => {
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Use POST.' },
    id: null,
  }));
});

app.delete('/mcp', (_req, res) => {
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Not supported.' },
    id: null,
  }));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Arccos MCP] v0.3.1 on port ${PORT}`);
});
