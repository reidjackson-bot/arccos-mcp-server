# Arccos Golf MCP Server

MCP server wrapping the Arccos dashboard REST API.
Reverse-engineered from `dashboard.arccosgolf.com`.

## Auth

Two-step token exchange, fully automated:

1. **`accessKey` + `userId`** → `POST authentication.arccosgolf.com/tokens` → **JWT**
2. **JWT** (3-hour lifetime) → `Authorization: Bearer: <jwt>` on all `api.arccosgolf.com` calls

The server caches the JWT in memory and auto-refreshes ~60s before expiry, or on a 401 retry. The `accessKey` is long-lived (only rotates if you change your password or log out everywhere).

### One-time setup: get your accessKey

```bash
ARCCOS_EMAIL=you@example.com ARCCOS_PASSWORD=yourpw npm run login
```

This prints your `userId` and `accessKey`. Set both as Railway env vars:

- `ARCCOS_USER_ID`
- `ARCCOS_ACCESS_KEY`

Your password is **never stored** — it's only used in this one call to obtain the long-lived accessKey.

## Tools

| Tool | Endpoint | Notes |
|---|---|---|
| `arccos_get_profile` | `GET /users/{userId}` | Name, handicap, home course, current bag ref |
| `arccos_get_skill_handicaps` | `GET /users/{userId}/handicaps/latest` | Drive / approach / chip / sand / putt handicaps |
| `arccos_get_player_summary` | `GET /sga/playerProfile/{userId}` | Quick rounds/holes/shots summary |
| `arccos_get_tour_summary` | `GET /users/{userId}/tourAnalyticsSummary` | Aggregate stats across all rounds |
| `arccos_get_rounds` | `GET /users/{userId}/rounds` | Paginated round list |
| `arccos_get_dashboard_analysis` | `GET /sga/getDashboardAnalysis/{userId}` | SG breakdown — single round (`roundId`) or rolling window (`noOfRounds`) |
| `arccos_get_round_metadata` | `GET /analytics/{roundId}` | Device/app metadata for a round |
| `arccos_get_clubs` | `GET /v6/users/{userId}/clubs` | Current bag with sensor IDs, makes, models |
| `arccos_get_club_distances` | `GET /v4/clubs/user/{userId}/smart-distances` | Per-club smart distance with terrain breakdown |

## Endpoints

- `POST /mcp` — MCP JSON-RPC over Streamable HTTP
- `GET /health` — Health check (includes cached token status)

## Deploy (Railway)

1. Connect the repo to Railway.
2. Set env vars: `ARCCOS_USER_ID` and `ARCCOS_ACCESS_KEY` (from `npm run login`).
3. `PORT` is auto-injected.
4. Build uses the included `Dockerfile`. No extra config needed.

## Local

```bash
ARCCOS_USER_ID=<id> ARCCOS_ACCESS_KEY=<key> npm start
```

## Notes

- `/v6/.../clubs` returns distances in **meters**; `/v4/.../smart-distances` returns yards (when `units=IMPERIAL`) or meters.
- `clubType` is an integer code — this server enriches `arccos_get_clubs` responses with a `clubTypeName` field. The mapping is best-effort; if a code maps to "Unknown", file an issue with the code value and the actual club it represents.
- `arccos_get_club_distances` returns `clubId` only; join with `arccos_get_clubs` to get the human-readable name.
- The Authorization wire format is literally `Bearer: <jwt>` (with a colon). This is non-standard but matches what Arccos expects — replicating verbatim.
