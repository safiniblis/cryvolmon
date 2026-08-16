# VM operations plan for real-time trend job

- task: wt-msv2wa3n-7ixaq
- assigned: groq/openai/gpt-oss-120b
- foreman reason: reasoning-heavy analysis requiring multi-step planning
- foreman acceptance: accepted — verification unavailable (verifier reply was not JSON: {
  "accept": false,
  "note": "The response covers many required elements (systemd unit, resource limits, secrets handl)
- ran: 3.9s
- done: 2026-08-16T01:06:13.283Z

---

## Cryvolmon + X‑Trend Collector – Operations Plan  
*Target: a single Linux VM that already runs the Cryvolmon trading engine. The new collector must run **independently** of the live‑trading process, be observable, and survive API‑rate‑limit or network outages.*

---

### 1. High‑level design  


+-------------------+          +-------------------+          +-------------------+
|  systemd service  |  exec →  |  collector script |  →  API  |  X/Twitter API    |
|  (cryvolmon‑trend)│          |  (python / go)   |          +-------------------+
+-------------------+          +-------------------+
        │                               │
        │ 20‑s loop → write state →      │
        │   health.json + rate‑limit.json│
        │                               │
        ▼                               ▼
+-------------------+          +-------------------+
|  Persistent store |  ←  write|  local FS / DB    |
|  (abstract)       |          |  (SQLite, PG, …) |
+-------------------+          +-------------------+

+-------------------+          +-------------------+
|  Prometheus       |  scrape  |  /metrics endpoint|
|  (or CloudWatch)  |←─────────|  (http server)    |
+-------------------+          +-------------------+

+-------------------+          +-------------------+
|  Logrotate        |  rotates |  /var/log/cryvol- |
|  (daily, 7d)      |←─────────|  mon‑trend.log   |
+-------------------+          +-------------------+

+-------------------+          +-------------------+
|  Alertmanager     |  receives|  alerts (stale,  |
|  (or PagerDuty)   |←─────────|  rate‑limit, err)|
+-------------------+          +-------------------+


*The collector is a **stand‑alone service** that only writes its own state files and metrics. Cryvolmon reads the latest trend data from the persistent store but never calls the X API directly.*

---

## 2. Service layout  

| Component | Path (Linux VM) | Purpose |
|-----------|----------------|---------|
| **systemd unit** | `/etc/systemd/system/cryvolmon‑trend.service` | Starts the collector, restarts on failure, enforces limits |
| **collector binary / script** | `/opt/cryvolmon/trend-collector/collector` | 20 s loop, API calls, back‑off, state persistence |
| **config** | `/etc/cryvolmon/trend-collector.yaml` | API endpoint, query parameters, secrets reference, storage driver |
| **secrets** | `/run/secrets/cryvolmon‑trend/*` (or Vault) | `X_API_TOKEN`, optional DB credentials |
| **state files** | `/var/lib/cryvolmon/trend/health.json`<br>`/var/lib/cryvolmon/trend/ratelimit.json` | JSON blobs for health checks & rate‑limit tracking |
| **persistent store** | *abstract* – e.g. `/var/lib/cryvolmon/trend/trends.db` (SQLite) or external PG URL |
| **metrics endpoint** | `http://127.0.0.1:9380/metrics` (exposed only on localhost) |
| **log file** | `/var/log/cryvolmon/trend.log` | STDOUT/STDERR → logrotate |
| **logrotate config** | `/etc/logrotate.d/cryvolmon‑trend` | Daily rotation, keep 7 days, compress |
| **health check script** | `/opt/cryvolmon/trend-collector/health.sh` | Returns 0 if recent data ≤ 60 s old and no rate‑limit breach |

---

### 2.1 systemd unit (example)

```ini
[Unit]
Description=Cryvolmon X‑Trend Collector
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=cryvolmon
Group=cryvolmon
WorkingDirectory=/opt/cryvolmon/trend-collector
ExecStart=/opt/cryvolmon/trend-collector/collector \
          --config /etc/cryvolmon/trend-collector.yaml \
          --metrics-addr 127.0.0.1:9380
Restart=on-failure
RestartSec=5
# Resource limits – tweak per VM size
CPUQuota=30%          # never use more than 30 % of a core
MemoryLimit=200M
# Protect the host
ProtectSystem=full
ProtectHome=yes
PrivateTmp=yes
ReadWriteDirectories=/var/lib/cryvolmon/trend /var/log/cryvolmon
EnvironmentFile=-/run/secrets/cryvolmon‑trend/env
# Optional: Rate‑limit the outbound connections
IPAccounting=yes
# Health check (systemd‑watchdog optional)
WatchdogSec=30
ExecStartPost=/opt/cryvolmon/trend-collector/health.sh

[Install]
WantedBy=multi-user.target


*Key points*  

* **Isolation** – `ProtectSystem=full` prevents accidental writes to the rest of the filesystem.  
* **Resource caps** – `CPUQuota` and `MemoryLimit` keep the collector from starving the trading engine.  
* **Secrets** – loaded from a runtime‑only directory (`/run/secrets`) that is populated by a secret‑injection tool (Docker‑secret‑like, Vault Agent, or cloud‑init). No token lives on disk.  
* **Watchdog** – systemd will kill the process if it fails to ping the watchdog within 30 s (collector must call `sd_notify("WATCHDOG=1")` or write to `/run/systemd/notify`).  

---

### 2.2 Collector logic (pseudo‑code)

```go
// main loop – 20 s target cycle
for {
    start := time.Now()

    // 1️⃣ Load persisted rate‑limit state (reset if >15 min old)
    rl := loadRateLimitState()

    // 2️⃣ If we are in back‑off (exponential, max 5 min) → sleep & continue
    if rl.BackoffUntil.After(time.Now()) {
        sleepUntil(rl.BackoffUntil)
        continue
    }

    // 3️⃣ Call X API (GET /2/tweets/search/recent?query=trending)
    resp, err := httpClient.Get(apiURL)
    if err != nil || resp.StatusCode >= 500 {
        // network / server error → back‑off
        rl.BackoffUntil = time.Now().Add(backoffDuration(rl.FailCount))
        rl.FailCount++
        persistRateLimitState(rl)
        logError(err)
        continue
    }

    // 4️⃣ Parse rate‑limit headers (x-rate-limit-remaining, reset)
    rl.Remaining = parseHeader(resp, "x-rate-limit-remaining")
    rl.ResetAt   = parseHeaderTime(resp, "x-rate-limit-reset")
    rl.FailCount = 0 // success clears fail count
    persistRateLimitState(rl)

    // 5️⃣ Decode payload → write trends