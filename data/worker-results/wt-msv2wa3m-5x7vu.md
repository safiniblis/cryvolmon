# Trend data model and scoring design

- task: wt-msv2wa3m-5x7vu
- assigned: groq/openai/gpt-oss-120b
- foreman reason: reasoning‑heavy analysis with multi‑step design, requires strong capabilities
- foreman acceptance: accepted — verification unavailable (verifier reply was not JSON: )
- ran: 4.9s
- done: 2026-08-16T01:03:03.398Z

---

**Cryvolmon – Real‑Time Crypto‑Twitter (X) Trend Engine**  
*Self‑contained data & analytics specification*  
*Target cadence: 20 seconds*  

---

## 1. Scope & Assumptions  

| # | Assumption | Reason / Impact |
|---|------------|-----------------|
| A1 | Access to the **Twitter API v2** (filtered stream & recent search). | Provides `id`, `text`, `author_id`, `created_at`, `public_metrics`, `possibly_sensitive`, `lang`, `referenced_tweets`, `entities` (hashtags, mentions, urls). |
| A2 | All tweets are in **UTF‑8**. | Guarantees consistent tokenisation. |
| A3 | “Crypto‑related” filter is a list of **keywords & symbols** (e.g., `btc`, `$BTC`, `bitcoin`, `eth`, `$ETH`, `#crypto`). | Used to seed the stream; non‑matching tweets are dropped. |
| A4 | Rate‑limit allows **≥ 10 k raw events / sec** (well above the expected volume). | Guarantees we can ingest every tweet that matches the filter. |
| A5 | “Author/source weighting” uses **verified status, follower count, and historical quality score** (see §4). | Provides a numeric weight for each tweet. |
| A6 | “Spam / bot” detection relies on a **lightweight heuristic** (see §5) that can be refined later with ML. | Keeps the spec functional without a trained model. |
| A7 | “Duplicate detection” works on **content hash + author + 30‑second window**. | Prevents echo‑chamber amplification. |
| A8 | All timestamps are stored as **UTC epoch‑ms**. | Guarantees deterministic bucket boundaries. |
| A9 | No external market data is required for the specification; all examples use symbolic variables (e.g., `V`, `E`, `S`). | Keeps the spec self‑contained. |

---

## 2. Raw Event Schema (as received from the API)

| Field | Type | Description | Required? |
|-------|------|-------------|-----------|
| `raw_id` | string | Twitter tweet ID (snowflake). | ✔ |
| `raw_text` | string | Full tweet text (including emojis). | ✔ |
| `raw_author_id` | string | User ID of the author. | ✔ |
| `raw_created_at` | integer (epoch‑ms) | Tweet creation time. | ✔ |
| `raw_lang` | string (ISO‑639‑1) | Language code (e.g., `en`). | ✔ |
| `raw_public_metrics` | object | `{ "retweet_count": int, "reply_count": int, "like_count": int, "quote_count": int }` | ✔ |
| `raw_possibly_sensitive` | bool | Flag from Twitter. | optional |
| `raw_entities` | object | `{ "hashtags": [{ "tag": string }], "mentions": [{ "username": string }], "urls": [{ "expanded_url": string }] }` | optional |
| `raw_verified` | bool | Author verified flag (extracted from user lookup). | optional (cached) |
| `raw_follower_count` | int | Author follower count (cached). | optional |
| `raw_source` | string | `"stream"` or `"search"` – origin of ingestion. | ✔ |

*All fields not listed may be ignored.*

---

## 3. Normalized Post Record (post‑level)

| Normalized Field | Type | Derivation |
|------------------|------|------------|
| `post_id` | string | `raw_id` |
| `timestamp` | integer (epoch‑ms) | `raw_created_at` |
| `author_id` | string | `raw_author_id` |
| `author_verified` | bool | `raw_verified` (default `false` if missing) |
| `author_followers` | int | `raw_follower_count` (default 0) |
| `lang` | string | `raw_lang` |
| `text` | string | `raw_text` (trimmed of leading/trailing whitespace) |
| `hashtags` | list[string] | lower‑cased `raw_entities.hashtags.tag` |
| `mentions` | list[string] | lower‑cased `raw_entities.mentions.username` |
| `urls` | list[string] | `raw_entities.urls.expanded_url` |
| `metrics` | object | copy of `raw_public_metrics` |
| `sensitive` | bool | `raw_possibly_sensitive` (default `false`) |
| `source` | string | `raw_source` |
| `content_hash` | string | SHA‑256 of `text` (used for duplicate detection) |
| `weight` | float | **Author weight** (see §4) × **Spam factor** (see §5) |
| `is_spam` | bool | Result of spam heuristic (see §5) |
| `is_duplicate` | bool | Result of duplicate detection (see §6) |

---

## 4. Author / Source Weighting  

A simple deterministic weight is sufficient for the 20‑s cadence.  


Wauthor = 1
        + 0.5 * log10( max(author_followers, 1) )
        + 2.0 * author_verified
        + 0.1 * historic_quality_score(author_id)   // 0‑1, default 0.5


*All logs are base‑10; `log10(1)=0`. The weight is **≥ 1**.*

**`historic_quality_score`** is a rolling average (0‑1) of past tweet quality signals (low spam, high engagement, diverse topics). It can be stored in a lightweight KV table.

**Final tweet weight** used in aggregation:


Wfinal = Wauthor * (1 - SpamPenalty)


where `SpamPenalty ∈ [0, 0.9]` (see §5).  

---

## 5. Spam / Bot Heuristic  

| Rule | Condition | Penalty |
|------|-----------|---------|
| S1 | `author_followers < 10` **AND** `author_verified = false` | 0.7 |
| S2 | `text` contains > 3 identical hashtags (e.g., `#btc #btc #btc`) | 0.5 |
| S3 | `text` length < 15 characters **AND** contains a crypto symbol | 0.4 |
| S4 | `metrics.retweet_count + metrics.like_count` < 2 **AND** `author_followers < 100` | 0.6 |
| S5 | `sensitive = true` | 0.3 |
| S6 | `author_id` appears in a **black‑list** (maintained externally) | 0.9 |

**SpamPenalty** = max( penalties of all triggered rules).  
If `SpamPenalty ≥ 0.8` → `is_spam = true` and the tweet is **excluded** from trend calculations (but stored for audit).

---

## 6. Duplicate Detection  

A tweet is a duplicate if **all** of the following hold:

1. `content_hash` matches a previously seen hash **within the last 30 seconds**.  
2. `author_id` is the same **or** the tweet is a *retweet/quote* (`referenced_tweets.type ∈ {retweeted, quoted}`) of an already‑ingested tweet.  

Implementation: a **time‑ordered LRU map** `hash → (timestamp, author_id)`.  

If duplicate → `is_duplicate = true` and the tweet is **ignored** for trend aggregation (but counted for “raw volume” metrics).

---

## 7. Time Bucketing (20‑second cadence)


bucket_start = floor(timestamp / 20_000) * 20_000   // epoch‑ms
bucket_end   = bucket_start + 20_000 - 1


All normalized posts are assigned to a bucket `B`.  
A **Bucket Record** aggregates the following per bucket:

| Metric | Formula (symbolic) |
|--------|-------------------|
| `post_cnt` | Σ 1 |
| `spam_cnt` | Σ is_spam |
| `dup_cnt`  | Σ is_duplicate |
| `engagement_score` | Σ (metrics.like_count + 2·metrics.retweet_count + metrics.reply_count) × Wfinal |
| `velocity` | `post_cnt / 20` (posts per second) |
| `symbol_mentions[s]` | Σ (occurrences of symbol *s* in text) × Wfinal |
| `hashtag_mentions[h]` | Σ (occurrences of hashtag *h*) × Wfinal |
| `sentiment_score` | Σ Sentiment(text) × Wfinal |
| `topic_score[t]` | Σ TopicClassifier(text) == t ? 1·Wfinal : 0 |
| `confidence` | `engagement_score / (post_cnt + 1)` (higher engagement → higher confidence) |

*All sums are over **non‑spam, non‑duplicate** posts.*

---

## 8. Symbol / Entity Extraction  

1. **Pre‑defined symbol dictionary** – e.g., `{BTC, ETH, SOL, DOGE, ...}` with optional prefixes `$`, `#`.  
2. **Regex extraction** on `text` (case‑insensitive):  


symbol_regex = /(?:\$|#)?\b([A-Z]{2,5})\b/g


3. **Disambiguation** – keep only symbols present in the dictionary; otherwise treat as plain word.  

Result stored as a **multiset** `symbols = { s → count }` per post.

---

## 9. Sentiment & Topic Signals  

| Signal | Method | Output |
|--------