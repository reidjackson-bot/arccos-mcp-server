# Arccos Golf MCP Server

MCP server wrapping the public Arccos dashboard REST API.
Reverse-engineered from `dashboard.arccosgolf.com` and `old.dashboard.arccosgolf.com`.

## Auth

None. Arccos's dashboard API is unauthenticated and user-id-scoped.
Set your user id via the `ARCCOS_USER_ID` environment variable.
You can find your user id in any dashboard URL: `dashboard.arccosgolf.com/user/{userId}/...`

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
- `GET /health` — Health check

## Deploy (Railway)

1. Connect the repo to Railway.
2. Set env var: `ARCCOS_USER_ID=<your_user_id>`.
3. `PORT` is auto-injected.
4. Build uses the included `Dockerfile`. No extra config needed.

## Local

```bash
ARCCOS_USER_ID=<your_user_id> npm start
```

## Notes

- The Arccos API returns distances in **meters** in `/v6/.../clubs` and in **yards** (when `units=IMPERIAL`) in `/v4/.../smart-distances`.
- `clubType` is an integer code — this server enriches `arccos_get_clubs` responses with a `clubTypeName` field. The mapping is best-effort; if a code maps to "Unknown", file an issue with the `clubType` value and the actual club it represents.
- `arccos_get_club_distances` returns `clubId` only; join with `arccos_get_clubs` to get the human-readable club name.
