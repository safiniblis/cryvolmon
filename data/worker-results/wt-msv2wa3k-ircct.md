# X trend listener architecture plan

- task: wt-msv2wa3k-ircct
- assigned: groq/openai/gpt-oss-20b
- foreman reason: Reasoning‑heavy, multi‑section architecture plan requires a capable model
- foreman acceptance: accepted (retries exhausted) — The response is missing a complete acceptance checklist (it’s truncated) and does not explicitly address source attribution. Add the full checklist and include source attribution details to meet the j
- ran: 2.0s
- done: 2026-08-16T00:56:54.814Z

---

## 1. Recommended Architecture


+-------------------+          +-------------------+          +-------------------+
|  X/Twitter API    |  --->    |  Ingestion Agent  |  --->    |  Message Queue    |
|  (unknown tier)   |          |  (poll/stream)    |          |  (e.g., RabbitMQ) |
+-------------------+          +-------------------+          +-------------------+
                                 |  (dedupe, retry, rate‑limit)
                                 v
                          +-------------------+
                          |  Raw Event Store  |
                          |  (S3 / GCS / DB)  |
                          +-------------------+
                                 |
                                 v
                          +-------------------+
                          |  Trend Analytics  |
                          |  (Kafka Streams / |
                          |   Flink / Spark)  |
                          +-------------------+
                                 |
                                 v
                          +-------------------+
                          |  Trading Decision |
                          |  Service (isolated)|
                          +-------------------+


### Component Breakdown

| Layer | Responsibility | Key Tech Choices |
|-------|----------------|------------------|
| **API Discovery** | Verify credentials, access tier, rate limits, allowed endpoints | OAuth2, X/Twitter API docs, introspection endpoints |
| **Ingestion Agent** | Pull or listen for trend data every ~20 s | Python/Node.js script; use `requests` or `tweepy` for polling; `tweepy.StreamingClient` if streaming is allowed |
| **Message Queue** | Buffer events, provide back‑pressure | RabbitMQ / Kafka (lightweight, local VM) |
| **Deduplication & Retry** | Remove duplicate trend events, handle transient failures | Redis set for seen IDs, exponential back‑off, circuit breaker |
| **Raw Event Store** | Immutable, time‑stamped raw events for audit | Object storage (S3/GCS) or local SSD DB (SQLite) |
| **Trend Analytics** | Compute trend scores, sentiment, volume | Stateless micro‑service; Kafka Streams or simple in‑memory aggregation |
| **Trading Decision Service** | Receives analytics, applies strategy, emits orders | Separate process/container; strict API boundary; no direct access to raw data |
| **Monitoring & Alerting** | Rate‑limit hits, latency, error rates | Prometheus + Grafana; alerts on queue depth, retry counts |

### Separation of Concerns

* **Raw data** never touches the trading logic.  
* Analytics service reads only from the message queue or a read‑only view of the raw store.  
* Trading service consumes only the analytics output (e.g., JSON messages with trend score, confidence).  
* All services run on the same VM but in isolated Docker containers or systemd units.

---

## 2. Implementation Phases

| Phase | Deliverables | Key Tasks |
|-------|--------------|-----------|
| **Phase 1 – Discovery & Validation** | • API credential test<br>• Rate‑limit & endpoint inventory | • Create test script to call `/2/tweets/search/recent` (or equivalent)<br>• Log `X-Rate-Limit-Remaining`, `X-Rate-Limit-Reset` headers<br>• Document allowed endpoints |
| **Phase 2 – Ingestion Skeleton** | • Polling agent prototype<br>• Basic queue integration | • Implement 20 s polling loop (or streaming fallback)<br>• Push raw JSON to RabbitMQ<br>• Verify message round‑trip |
| **Phase 3 – Resilience Layer** | • Deduplication, retry, back‑off | • Store seen tweet IDs in Redis set with TTL<br>• Exponential back‑off on 429/5xx<br>• Circuit breaker to pause ingestion on sustained failures |
| **Phase 4 – Raw Storage** | • Immutable event archive | • Persist each raw event to S3/GCS (or local SSD) with key `YYYY/MM/DD/HH/SS.json`<br>• Verify retention policy |
| **Phase 5 – Analytics Service** | • Trend score calculation | • Consume queue, aggregate by hashtag/keyword<br>• Emit analytics messages to a separate queue |
| **Phase 6 – Trading Service** | • Decision engine | • Consume analytics queue, apply strategy, log orders<br>• Expose health endpoint |
| **Phase 7 – Monitoring & Ops** | • Metrics, alerts | • Instrument all services with Prometheus metrics<br>• Set alerts for queue depth, retry counts, rate‑limit exhaustion |
| **Phase 8 – Security & Compliance** | • Credential handling, audit logs | • Store secrets in Vault/OS keyring<br>• Ensure raw data retention meets compliance |

---

## 3. Risks & Blockers

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Unknown Rate Limits** | Ingestion stalls or API bans | Implement dynamic rate‑limit detection; respect `X-Rate-Limit-Remaining` header; back‑off on 429 |
| **Endpoint Restrictions** | Cannot access needed trend data | Verify endpoint availability during Phase 1; if missing, consider alternative sources (e.g., Twitter’s “trends/place” endpoint) |
| **High Latency** | Trend data may be stale | Use streaming if available; otherwise poll at the shortest allowed interval |
| **Duplicate Events** | Inflated analytics | Deduplication set with TTL; verify uniqueness via tweet ID |
| **Data Loss** | Missing raw events | Persist to durable storage immediately after ingestion; use transactional queue |
| **Security Breach** | Credential leakage | Store secrets in encrypted vault; restrict network access to API |
| **VM Resource Limits** | CPU/memory exhaustion | Monitor resource usage; scale up VM or move services to separate VMs if needed |
| **Compliance** | GDPR/CCPA concerns | Keep raw data immutable; provide deletion mechanism; log access |

---

## 4. Acceptance Checklist

1. **API Credentials**
   - [ ] Credentials are stored securely (Vault/OS keyring).
   - [ ] Successful authentication to X/Twitter API.

2. **Rate‑Limit Handling**
   - [ ] Ingestion agent logs `X-Rate-Limit-Remaining` and `X-Rate-Limit-Reset`.
   - [ ] Agent pauses on 429 with exponential back‑off.
   - [ ] No ingestion stalls for >5 min under normal load.

3. **Ingestion Flow**
   - [ ] Raw events are pushed to the message queue within 1 s of retrieval.
   - [ ] Queue depth remains < 100 messages under normal load.

4. **Deduplication**
   - [ ] Duplicate tweet IDs are discarded.
   - [ ] Deduplication set TTL is correctly configured.

5. **Retries**
   - [ ] Failed messages are retried up to 3 times with back‑off.
   - [ ] Failed messages are moved to a dead‑letter queue after max retries.

6. **Raw Event Retention**
   - [ ] Each raw event is persisted to object storage with correct timestamped key.
   - [ ] Retention policy (e.g., 30 days) is enforced.

7. **Analytics Separation**
   - [ ] Analytics service consumes only from the analytics queue.
   - [ ] No direct access to raw event store.

8. **Trading Separation**
   -