# Real-Time Chat Application

A group messaging backend you can scale out. It has rooms, direct messages, online presence and typing indicators, and keeps message history and user sessions in PostgreSQL. Socket.IO broadcasts go through Redis pub/sub, so you can run any number of server instances behind a load balancer.

**Stack:** Node.js · Express 5 · Socket.IO 4 · PostgreSQL 16 · Redis 7 · JWT · Docker Compose · GitHub Actions · Jest

```
          ┌──────────────┐           ┌──────────────┐
 client ──┤  instance A  │           │  instance B  ├── client
 (ws/REST)│ Express + IO │           │ Express + IO │  (ws/REST)
          └──┬────────┬──┘           └──┬────────┬──┘
             │        │   pub/sub       │        │
             │        └──────► Redis ◄──┘        │   presence leases,
             │                 (adapter, rate    │   rate-limit windows
             │                  limits, presence)│
             └──────────► PostgreSQL ◄───────────┘
                     users · sessions · rooms
                     room_members · messages
```

## Features

| Area | What it does |
| --- | --- |
| **Messaging** | Group rooms and 1:1 direct messages. You can send over the WebSocket (with an ack) or over REST. Either way the message is saved and then pushed to every member's sockets. |
| **Horizontal scaling** | `@socket.io/redis-adapter` sends room broadcasts, `socketsJoin` and `disconnectSockets` to every instance over Redis pub/sub. A client on instance A receives messages sent through instance B. |
| **Presence** | Presence is tracked across the whole cluster in Redis. Each socket holds a lease (an entry in a sorted set) that its instance renews on a heartbeat. A user with two tabs stays online until both tabs close. If an instance crashes, its sockets drop offline when their leases run out, instead of staying "online" forever. |
| **Auth** | bcrypt password hashes. Each JWT is tied to a row in the PostgreSQL `sessions` table, so logging out revokes that token on the server and disconnects that session's sockets on every instance. Other devices stay logged in. |
| **History pagination** | Opaque cursors that wrap the last message id (`WHERE id < $cursor ORDER BY id DESC`). Each page uses the `(room_id, id DESC)` index, and new messages arriving while you page don't shift or duplicate older pages (OFFSET paging does). |
| **Rate limiting** | A sliding-window limiter stored in a Redis sorted set, per user, shared by REST and WebSocket sends. It holds across all instances. Responses include `X-RateLimit-*` and `Retry-After` headers. Rejected attempts don't use up quota. |
| **Ops** | Docker Compose runs two app instances plus Postgres and Redis. There's a `/healthz` endpoint, graceful shutdown, and advisory-locked migrations so instances can boot at the same time. CI runs the integration suite on every pull request. |

## Quick start

### Docker (recommended)

```bash
docker compose up --build
```

This starts **two** app instances, `app1` on <http://localhost:3000> and `app2` on <http://localhost:3001>, sharing Postgres and Redis. Open one in each browser window, register two users, and chat across instances. The bundled demo client at `/` covers rooms, DMs (click a user in the Online list), typing indicators and "load older" pagination.

### Local Node

Needs Node 20+ and a running PostgreSQL and Redis.

```bash
cp .env.example .env      # adjust if needed, then export the variables
npm install
npm start
```

The schema in [`db/schema.sql`](db/schema.sql) is applied automatically on startup.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP and WebSocket port |
| `DATABASE_URL` | `postgres://chat:chat@localhost:5432/chat` | PostgreSQL connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `JWT_SECRET` | dev value | **Required** when `NODE_ENV=production` |
| `JWT_TTL_SECONDS` | `86400` | Token and session lifetime |
| `MESSAGE_RATE_LIMIT` | `10` | Messages allowed per user per window |
| `MESSAGE_RATE_WINDOW_MS` | `10000` | Sliding window length |
| `PRESENCE_TTL_MS` | `60000` | Presence lease length; heartbeat runs every TTL/3 |
| `INSTANCE_ID` | `hostname-pid` | Shown in `/healthz` |
| `CORS_ORIGIN` | `*` | Socket.IO CORS origin |

## REST API

Every route except register, login and `/healthz` needs `Authorization: Bearer <token>`. Errors look like `{ "error": { "code", "message" } }`.

| Method & path | Description |
| --- | --- |
| `POST /api/auth/register` | `{ username, password }` → `201 { user, token }` |
| `POST /api/auth/login` | `{ username, password }` → `{ user, token }` |
| `POST /api/auth/logout` | Revokes this session and disconnects its sockets → `204` |
| `GET /api/auth/me` | Current user |
| `GET /api/rooms` | Rooms you belong to, with member counts |
| `GET /api/rooms/public` | All group rooms |
| `POST /api/rooms` | `{ name }` → creates a room and makes you a member |
| `POST /api/rooms/:id/join` · `/leave` | Join or leave a group room |
| `GET /api/rooms/:id/messages?limit=&cursor=` | Newest-first history → `{ messages, nextCursor }` (default limit 50, max 100) |
| `POST /api/rooms/:id/messages` | `{ body }` → `201 { message }`. **Rate limited** (`429` + `Retry-After`) |
| `POST /api/dm/:userId` | Gets or creates the direct conversation with a user |
| `GET /api/presence` | Ids of users currently online, across the cluster |
| `GET /api/presence/:userId` | `{ userId, online }` |
| `GET /healthz` | Checks Postgres and Redis → `{ status, instance }` |

Paging through history:

```bash
curl -H "Authorization: Bearer $T" "localhost:3000/api/rooms/1/messages?limit=20"
# → { "messages": [...20 newest...], "nextCursor": "eyJpZCI6MTAxfQ" }
curl -H "Authorization: Bearer $T" "localhost:3000/api/rooms/1/messages?limit=20&cursor=eyJpZCI6MTAxfQ"
```

## WebSocket protocol

Connect with `io(url, { auth: { token } })`. Connections without a valid, unrevoked session are rejected with `connect_error: unauthorized`.

| Direction | Event | Payload / ack |
| --- | --- | --- |
| server → client | `session:ready` | `{ user, roomIds }`, sent once your sockets have joined all your rooms |
| client → server | `message:send` | `{ roomId, body }` → ack `{ ok, message }` or `{ ok: false, error }` |
| client → server | `room:join` / `room:leave` | `{ roomId }` → ack |
| client → server | `typing` | `{ roomId }`, relayed to the other members |
| client → server | `presence:list` | → ack `{ ok, userIds }` |
| server → client | `message:new` | message object |
| server → client | `presence:update` | `{ userId, username, online }` when a user's first socket connects or last socket disconnects |
| server → client | `typing` | `{ roomId, userId, username }` |
| server → client | `room:joined` | `{ room }` when you were added to a room, e.g. someone opened a DM with you |

```js
const socket = io('http://localhost:3000', { auth: { token } });
socket.on('message:new', (m) => console.log(`${m.senderUsername}: ${m.body}`));
const ack = await socket.emitWithAck('message:send', { roomId: 1, body: 'hello' });
```

## Data model

```
users(id, username UNIQUE, password_hash, created_at)
sessions(id UUID, user_id, user_agent, created_at, expires_at, revoked_at)
rooms(id, name, kind 'group'|'direct', direct_key UNIQUE, created_by, created_at)
room_members(room_id, user_id, joined_at)              PK (room_id, user_id)
messages(id BIGSERIAL, room_id, sender_id, body, created_at)
  INDEX messages_room_id_idx (room_id, id DESC)        -- cursor pagination
```

A direct conversation is a `direct` room keyed by the sorted pair of user ids (`"3:7"`). The unique `direct_key` means two users who open a DM with each other at the same moment end up in the same room.

**Redis keys:**
- `presence:user:<id>`: sorted set of socket id → lease expiry
- `presence:users`: set of possibly-online user ids
- `ratelimit:messages:<userId>`: sorted set of send timestamps
- `socket.io#*`: adapter pub/sub channels

## Testing

The integration tests run against real PostgreSQL and Redis:

```bash
docker compose up -d postgres redis
npm test             # all suites, run in band
npm run test:unit    # pure unit tests, no services needed
```

| Suite | Covers |
| --- | --- |
| `auth.test.js` | register/login validation, duplicate users, forged/garbage tokens, server-side logout, per-device sessions |
| `rooms.test.js` | create/join/leave, discovery, DM idempotency and privacy |
| `messages.test.js` | membership checks, body validation, cursor walk over 23 messages in 3 pages with no gaps or duplicates, stable pages while new messages arrive, 429 + `Retry-After` + recovery, per-user limits |
| `socket.test.js` | handshake auth, ack plus broadcast only to members, REST → socket push, live room joins, DMs, typing, shared rate limit, multi-tab presence, logout disconnect |
| `scaling.test.js` | **two server instances**: cross-instance messages, REST fan-out, remote `socketsJoin`, cluster-wide presence, cross-instance logout, lease expiry after an instance crash |
| `unit/cursor.test.js` | cursor encoding and limit parsing |

[GitHub Actions](.github/workflows/ci.yml) runs on every pull request and every push to `main`. One job runs the full suite against Postgres and Redis service containers. A second job builds the image, starts the Compose stack and checks that both instances report healthy.

## Project layout

```
src/
  index.js               entry point, graceful shutdown
  server.js              wires one instance: pg pool, redis clients, express, socket.io + redis adapter
  config.js              env configuration
  db.js                  pool, advisory-locked migrations, transactions
  routes.js              REST endpoints
  middleware.js          auth, rate limit, error handling
  services/              auth (bcrypt, JWT, sessions), rooms, messages
  realtime/socket.js     socket.io auth middleware, events, cross-instance facade
  realtime/presence.js   lease-based presence (Lua scripts for atomic connect/disconnect)
  lib/                   cursor, sliding-window rate limiter, HTTP errors
db/schema.sql
public/index.html        dependency-free demo client
test/                    Jest + Supertest + socket.io-client integration tests
```

## License

MIT
