# Data Architecture

How guild-content data is captured, stored, and served for the (s)hoes Maplestory charts site.

There is **no Google in the read path** — Workers KV is the sole source of truth.
SwissKnife's CSV backup and optional direct Google Sheets upload are independent
safety copies the site never reads.

```mermaid
flowchart TB
    game["Game / Nexon traffic<br/>(guild-content ranking responses)"]

    subgraph sk["SwissKnife mitmproxy addon (nexon_analyzer / guild_wars.py)"]
        parse["parse rankings → rows[]"]
        kvup["_upload_to_kv() → POST /chart"]
        csv["CSV backup<br/>backups/&lt;mode&gt;_&lt;date&gt;.csv"]
        gsheet["optional direct Google Sheets"]
    end

    game -->|intercepted| parse
    parse --> kvup
    parse --> csv
    parse --> gsheet

    subgraph worker["Cloudflare Worker (worker.js) — static host + data API + ingestion"]
        router{"fetch() router"}
        handleChart["handleChartUpload"]
        handleGuild["handleGuild (POST/GET)"]
        handleApi["handleApi (GET /api)"]
        assets["env.ASSETS → public/"]
        userinfo["UserInfo Worker proxy<br/>(owner-only)"]
        router -->|POST /chart| handleChart
        router -->|/guild| handleGuild
        router -->|GET /api| handleApi
        router -->|/charts /arena / *| assets
        router -->|/userinfo| userinfo
    end

    kvup -->|"POST /chart<br/>Bearer CHART_WRITE_KEY<br/>{type, date, rows[]}"| router
    kvup -.->|"POST /guild<br/>Bearer ROSTER_WRITE_KEY"| router

    subgraph kv["Workers KV"]
        chartdata[("CHART_DATA<br/>names:&lt;type&gt; {updated, sheets[]}<br/>data:&lt;type&gt;:&lt;date&gt; {rows[], rosters{}, perfProfile?}<br/>guildweeks:&lt;type&gt; {guild: [dates]}")]
        rosters[("ROSTERS<br/>&lt;world&gt;:&lt;guild&gt; → [{nick,cp,cls,level}]")]
    end

    handleChart -->|"write: normalize rows,<br/>embed roster snapshot,<br/>merge guildweeks, stamp updated"| chartdata
    handleChart -->|read roster to embed| rosters
    handleGuild -->|read / write| rosters
    handleApi -->|"read (no-store → always fresh)"| chartdata

    subgraph browser["Browser — static front-end (public/)"]
        charts["Charts.html<br/>loads css/*.css + ordered js/*.js (d3 → main last)"]
        io["io.js env detection"]
        remote["IS_REMOTE → apiCall() GET /api"]
        local["IS_LOCAL → inject SampleData/*LocalData.js (no network)"]
        render["data.js parse → chart.js buildChart → d3 scatter + regression"]
        charts --> io
        io --> remote
        io --> local
        remote --> render
        local --> render
    end

    handleApi -->|"getSheetNames / getData / getLastUpdated<br/>+ x-last-updated header"| remote
    assets -->|Charts.html, js/, css/, SampleData/| charts

    classDef store fill:#2a2a3a,stroke:#f0a500,color:#fff;
    classDef safety stroke-dasharray: 4 3;
    class chartdata,rosters store;
    class csv,gsheet safety;
```

## The three data paths

**Write (ingestion).** SwissKnife reads ranking responses from game traffic →
`POST /chart` (Bearer `CHART_WRITE_KEY`). The Worker normalizes rows (drops
missing cp/score), pulls and **embeds the guild roster snapshot** from the
`ROSTERS` namespace, writes `data:<type>:<date>`, merges `guildweeks:<type>`, and
upserts the date into `names:<type>` with a fresh `updated` stamp. Rosters arrive
separately via `POST /guild` → `ROSTERS` KV.

**Read (page load).** Browser GETs `/api?action=…` → Worker reads from
`CHART_DATA` KV and serves `{ rows, rosters, perfProfile }` as-is (KV is
authoritative; a miss returns an empty result, no upstream). Responses are
`no-store`, so Reload is always fresh; the `x-last-updated` header drives the
"Last updated" display.

**Local debug.** No network — `io.js` detects `IS_LOCAL` (`file://`, `localhost`,
or no `API_URL`) and injects `SampleData/*LocalData.js` instead of calling `/api`.
