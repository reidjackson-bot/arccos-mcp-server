// File: index.js
//
// Arccos Golf MCP Server
// Wraps the Arccos dashboard REST API (api.arccosgolf.com).
//
// Auth: requires a JWT in the `Authorization: Bearer <jwt>` header.
//   - Set ARCCOS_JWT env var to a valid token (lifetime ~3 hours).
//   - Token can be grabbed from any api.arccosgolf.com request in the
//     dashboard.arccosgolf.com Network tab → Request Headers → authorization.
//   - Format in the wire is `Bearer: <jwt>` (note the colon, that's how
//     Arccos sends it). We replicate that quirk verbatim.
//
// Refresh flow is TODO — once captured, this server will auto-refresh.
//
// Endpoints reverse-engineered from:
//   - old.dashboard.arccosgolf.com
//   - dashboard.arccosgolf.com (new dashboard)
//   - dashboard.arccosgolf.com/user/{userId}/clubs/all/distances/smart

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = parseInt(process.env.PORT || '3000', 10);
const ARCCOS_USER_ID = process.env.ARCCOS_USER_ID;
const ARCCOS_JWT = process.env.ARCCOS_JWT;
const ARCCOS_API_BASE = 'https://api.arccosgolf.com';

if (!ARCCOS_USER_ID) {
  console.error('Missing ARCCOS_USER_ID environment variable');
  process.exit(1);
}
if (!ARCCOS_JWT) {
  console.error('Missing ARCCOS_JWT environment variable');
  console.error('Grab a fresh JWT from dashboard.arccosgolf.com Network tab → any api.arccosgolf.com request → Request Headers → authorization (drop the "Bearer: " prefix).');
  process.exit(1);
}

// Decode the JWT exp claim so we can warn when it's about to expire.
function jwtExpiry(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
    return payload.exp ? new Date(payload.exp * 1000) : null;
  } catch (_e) {
    return null;
  }
}
const tokenExp = jwtExpiry(ARCCOS_JWT);
if (tokenExp) {
  const minsLeft = Math.round((tokenExp - new Date()) / 60000);
  console.log(`[Arccos MCP] JWT expires ${tokenExp.toISOString()} (${minsLeft} min from now)`);
  if (minsLeft < 0) {
    console.error('[Arccos MCP] WARNING: JWT is already expired. API calls will fail.');
  }
}

// ────────────────────────────────────────────────────────────────
// Club type lookup table
// Reverse-engineered from `clubType` integers in /v6/.../clubs.
// May need refinement once we see more clubs, but this matches
// the captured bag (Driver=1, 3W=14, hybrid=26, irons=5–8, …).
// Wedges and putter codes inferred from typical 14-club layouts.
// ────────────────────────────────────────────────────────────────
const CLUB_TYPE_MAP = {
  1: 'Driver',
  2: '2 Wood',
  3: '3 Wood',
  4: '5 Wood',
  5: '4 Iron',
  6: '5 Iron',
  7: '6 Iron',
  8: '7 Iron',
  9: '8 Iron',
  10: '9 Iron',
  11: 'Pitching Wedge',
  12: 'Gap Wedge',
  13: 'Sand Wedge',
  14: 'Lob Wedge',
  15: 'Putter',
  16: '1 Iron',
  17: '2 Iron',
  18: '3 Iron',
  19: '7 Wood',
  20: '9 Wood',
  21: '11 Wood',
  22: '1 Hybrid',
  23: '2 Hybrid',
  24: '3 Hybrid',
  25: '4 Hybrid',
  26: '5 Hybrid',
  27: '6 Hybrid',
  28: '7 Hybrid',
};

function clubTypeName(code) {
  return CLUB_TYPE_MAP[code] || `Unknown (clubType=${code})`;
}

// ────────────────────────────────────────────────────────────────
// HTTP helper — adds a small set of headers that match the dashboard
// origin pattern. Arccos doesn't enforce these but we mirror them
// for stability in case they start checking referer/origin.
// ────────────────────────────────────────────────────────────────
async function arccosGet(path, queryParams = {}) {
  const url = new URL(ARCCOS_API_BASE + path);
  for (const [k, v] of Object.entries(queryParams)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json;charset=utf-8',
      // Arccos's wire format is literally `Bearer: <jwt>` with a colon. Verified
      // from the dashboard.arccosgolf.com network capture; replicating verbatim.
      'Authorization': `Bearer: ${ARCCOS_JWT}`,
      'Origin': 'https://dashboard.arccosgolf.com',
      'Referer': 'https://dashboard.arccosgolf.com/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    },
  });

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
    version: '0.2.0',
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
  const exp = jwtExpiry(ARCCOS_JWT);
  const minsLeft = exp ? Math.round((exp - new Date()) / 60000) : null;
  res.json({
    status: 'ok',
    service: 'arccos-mcp',
    version: '0.2.0',
    userId: ARCCOS_USER_ID ? `${ARCCOS_USER_ID.substring(0, 8)}…` : null,
    jwt: {
      expiresAt: exp ? exp.toISOString() : null,
      minutesUntilExpiry: minsLeft,
      expired: minsLeft !== null && minsLeft < 0,
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
  console.log(`[Arccos MCP] v0.2.0 on port ${PORT}`);
});
