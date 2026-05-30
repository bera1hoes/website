# UserInfo API

REST API for storing and querying opponent player data captured by MapleStory: Idle RPG.

**Base URL (production):** Set by Cloudflare after `wrangler deploy`  
**Base URL (local dev):** `http://localhost:8787`

---

## Authentication

All requests require a Bearer token in the `Authorization` header.

| Key | Used for |
|-----|----------|
| `WRITE_KEY` | `POST /userinfo` only |
| `READ_KEY` | `GET /userinfo` only |

Each key is bound to its HTTP method — sending the wrong key returns `401`.

```
Authorization: Bearer <key>
```

---

## Database Schema

```sql
CREATE TABLE userinfo (
    nick               TEXT     NOT NULL,
    battle_power       REAL     NOT NULL,
    short_battle_power TEXT     NOT NULL,   -- computed server-side, e.g. "67M 566K"
    raw_json           TEXT     NOT NULL,
    source_path        TEXT,                -- nullable, e.g. "/get_guild_league_user_ranking_list"
    captured_at        INTEGER  NOT NULL,   -- Unix seconds, from app
    uploaded_at        INTEGER  NOT NULL,   -- Unix seconds, set by server on insert
    PRIMARY KEY (nick, battle_power)
);
```

**Dedup:** `(nick, battle_power)` is the composite primary key. Re-uploading the same pair is silently ignored (`INSERT OR IGNORE`).

**`short_battle_power`** is computed by the Worker from `battle_power` using the same gaming-notation logic as the Python pipeline (e.g. `67566123` → `"67M 566K"`). The app never sends this field.

---

## Endpoints

### POST /userinfo

Upload one or more player rows. Requires `WRITE_KEY`.

**Request**

```
POST /userinfo
Authorization: Bearer <WRITE_KEY>
Content-Type: application/json
```

```json
{
  "rows": [
    {
      "nick":         "Shiromu",
      "battle_power": 67566123,
      "raw_json":     "{\"RankerInfos\":[...]}",
      "source_path":  "/get_guild_league_user_ranking_list",
      "captured_at":  1716940800
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `nick` | string | yes | Player nickname |
| `battle_power` | number | yes | Raw numeric battle power |
| `raw_json` | string | yes | Full JSON payload from the game server |
| `source_path` | string | no | API path the data was captured from |
| `captured_at` | integer | yes | Unix timestamp (seconds) when the data was captured |

**Response `200 OK`**

```json
{ "inserted": 1, "skipped": 0 }
```

| Field | Description |
|-------|-------------|
| `inserted` | Rows that were new and written to the database |
| `skipped` | Rows that were duplicates (same `nick` + `battle_power`) and ignored |

**Errors**

| Status | Body | Cause |
|--------|------|-------|
| `400` | `{"error":"rows must be a non-empty array"}` | Missing or empty `rows` |
| `400` | `{"error":"Each row requires nick, battle_power, raw_json, captured_at"}` | A row is missing a required field |
| `400` | `{"error":"Invalid JSON body"}` | Request body is not valid JSON |
| `401` | `{"error":"Unauthorized"}` | Missing or wrong Bearer token |
| `405` | `{"error":"Method not allowed"}` | Wrong HTTP method |

---

### GET /userinfo

Query player rows by nick. Requires `READ_KEY`.

**Request**

```
GET /userinfo?nick=<nick>[&battle_power=<bp>][&short_battle_power=<sbp>]
Authorization: Bearer <READ_KEY>
```

| Query param | Type | Required | Description |
|-------------|------|----------|-------------|
| `nick` | string | yes | Player nickname to look up |
| `battle_power` | number | no | Filter to a specific numeric battle power |
| `short_battle_power` | string | no | Filter by gaming-notation string, e.g. `"67M 566K"` |

`battle_power` and `short_battle_power` are mutually exclusive — if both are provided, `battle_power` takes precedence.

**Response `200 OK`**

```json
{
  "rows": [
    {
      "raw_json":           "{\"RankerInfos\":[...]}",
      "battle_power":       67566123,
      "short_battle_power": "67M 566K",
      "captured_at":        1716940800
    }
  ]
}
```

Rows are ordered by `captured_at DESC` (most recent first). An unknown nick returns `rows: []`, not a 404.

**Errors**

| Status | Body | Cause |
|--------|------|-------|
| `400` | `{"error":"nick query parameter is required"}` | `nick` param missing |
| `400` | `{"error":"battle_power must be a number"}` | `battle_power` param is not numeric |
| `401` | `{"error":"Unauthorized"}` | Missing or wrong Bearer token |
| `405` | `{"error":"Method not allowed"}` | Wrong HTTP method |
| `404` | `{"error":"Not found"}` | Path other than `/userinfo` |

---

## Examples (PowerShell)

```powershell
$writeKey = "your-write-key"
$readKey  = "your-read-key"
$base     = "http://localhost:8787"   # or production URL
```

**Write a row:**
```powershell
Invoke-RestMethod -Method POST "$base/userinfo" `
  -Headers @{ Authorization = "Bearer $writeKey"; "Content-Type" = "application/json" } `
  -Body '{"rows":[{"nick":"Shiromu","battle_power":67566123,"raw_json":"{\"x\":1}","captured_at":1716940800}]}'
# { inserted: 1, skipped: 0 }
```

**Re-upload the same row (dedup):**
```powershell
Invoke-RestMethod -Method POST "$base/userinfo" `
  -Headers @{ Authorization = "Bearer $writeKey"; "Content-Type" = "application/json" } `
  -Body '{"rows":[{"nick":"Shiromu","battle_power":67566123,"raw_json":"{\"x\":1}","captured_at":1716940800}]}'
# { inserted: 0, skipped: 1 }
```

**Get all rows for a nick:**
```powershell
Invoke-RestMethod "$base/userinfo?nick=Shiromu" `
  -Headers @{ Authorization = "Bearer $readKey" }
```

**Get a specific battle power snapshot:**
```powershell
Invoke-RestMethod "$base/userinfo?nick=Shiromu&battle_power=67566123" `
  -Headers @{ Authorization = "Bearer $readKey" }
```

**Get all snapshots matching a gaming-notation string:**
```powershell
Invoke-RestMethod "$base/userinfo?nick=Shiromu&short_battle_power=67M+566K" `
  -Headers @{ Authorization = "Bearer $readKey" }
```

**Unknown nick returns empty, not 404:**
```powershell
Invoke-RestMethod "$base/userinfo?nick=Nobody" `
  -Headers @{ Authorization = "Bearer $readKey" }
# { rows: [] }
```

---

## Python example

```python
import requests

BASE = "https://<your-worker>.workers.dev"
READ_KEY = "your-read-key"

resp = requests.get(
    f"{BASE}/userinfo",
    params={"nick": "Shiromu"},
    headers={"Authorization": f"Bearer {READ_KEY}"},
)
rows = resp.json()["rows"]
for row in rows:
    print(row["short_battle_power"], row["captured_at"])
```
