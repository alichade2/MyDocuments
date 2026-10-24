# Part 20 — 50+ Scenario-Based Questions

Each scenario lists: **investigation / possible causes → solution → alternatives & trade-offs → interview-ready line.** Practise answering in 60–90 seconds.

## A. Concurrency and data consistency

**1. Two users book the same appointment at the same time. How do you prevent double booking?**
*Causes:* check-then-insert race. *Solution:* enforce the invariant in the **database** — a unique constraint on `(doctor_id, slot_start)` or on `slot_id` in appointments; catch `DataIntegrityViolationException` and return 409. Or a conditional update `UPDATE slots SET status='BOOKED' WHERE id=? AND status='FREE'` and check the updated row count. *Alternatives:* optimistic locking with `@Version`; `SELECT … FOR UPDATE` (pessimistic) for hot slots; a temporary hold with TTL. *Trade-off:* constraints are simplest and safest; pessimistic locks reduce throughput. *Say:* "I never rely on application-level checks alone; the database constraint is the last line of defence."

**2. A payment succeeds but the order is not updated. How do you handle it?**
*Causes:* crash/timeout between payment confirmation and DB update; lost webhook; dual-write. *Solution:* make payment confirmation **idempotent** and durable: store the payment result and an outbox event in the same transaction; process provider webhooks idempotently; run a **reconciliation job** comparing provider records and orders; keep orders in a `PAYMENT_PENDING` state until confirmed. *Alternatives:* orchestrated saga with a timeout and compensation (refund). *Say:* "Assume messages can be lost or duplicated, so state changes are idempotent and reconciled."

**3. A Kafka message is processed twice. How do you prevent duplicate business effects?**
*Solution:* idempotent consumer — store a processed event id with a unique constraint in the same transaction as the effect; or use naturally idempotent operations (upsert, set state); enable producer idempotence. *Trade-off:* exactly-once delivery is not generally possible end to end; aim for exactly-once *effect*.

**4. Two services need to update related business data. How do you maintain consistency?**
*Solution:* avoid distributed transactions; use a **saga** (orchestration or choreography) with compensations and the **outbox** pattern; design for eventual consistency with pending states. *Alternative:* merge the services if the data really must be consistent atomically (maybe they were split wrongly).

**5. Inventory is oversold during a flash sale.**
*Causes:* read-modify-write race. *Solution:* atomic `UPDATE … SET available = available - ? WHERE available >= ?`; reserve stock with TTL; queue requests; Redis atomic decrement then asynchronous reconciliation. *Trade-off:* strict DB locking limits throughput; Redis introduces reconciliation complexity.

**6. A counter in a multi-instance service gives wrong totals.**
*Causes:* in-memory `AtomicInteger` per instance; `count++` race. *Solution:* database atomic update, Redis `INCR`, or event aggregation. In a single JVM, use `AtomicLong`/`LongAdder`.

**7. A scheduled job runs twice because the service has three instances.**
*Solution:* distributed lock (ShedLock with DB/Redis), leader election, or a single scheduler component/Kubernetes CronJob; make the job idempotent regardless.

**8. Optimistic locking failures spike (`ObjectOptimisticLockingFailureException`).**
*Causes:* high contention on the same rows, long transactions, large aggregates. *Solution:* retry with backoff (a few times), reduce transaction time, split hot aggregates, or switch to atomic updates/pessimistic lock for the hot path. Return 409 with guidance to the client when retries fail.

**9. A DB deadlock is reported in logs.**
*Investigate:* the DB deadlock report (which statements, locks). *Solution:* acquire locks/rows in a consistent order, shorten transactions, add indexes so fewer rows are locked, and retry the victim transaction.

**10. The same request is sent twice (user double-clicks "Pay").**
*Solution:* client disables the button; server requires an `Idempotency-Key`; unique `(user, key)` record returns the original response.

## B. Spring and JPA

**11. A Spring bean is not getting injected. What do you check?**
Is the class annotated and inside the component-scan path? Is it created with `new`? Multiple candidates (`NoUniqueBeanDefinitionException` → `@Primary`/`@Qualifier`)? Missing conditional (`@Profile`, `@ConditionalOnProperty`)? A circular dependency? Wrong `jakarta` vs `javax` annotation? Use `--debug`, Actuator `/beans`, and the exception message (it tells you the type and the injection point).

**12. `@Transactional` is not rolling back. Why?**
Checked exception without `rollbackFor`; exception swallowed; self-invocation; non-public/final method; bean not proxied; work on another thread; an inner `REQUIRES_NEW` committed; `readOnly` misunderstanding. Verify with transaction logging (`TRACE` on `org.springframework.transaction.interceptor`).

**13. A JPA endpoint triggers hundreds of SQL queries.**
N+1. Confirm with SQL logging/statistics; fix with `join fetch` / `@EntityGraph` / batch fetch size / DTO projection; verify with a query-count test; prevent with code review and `LAZY` defaults.

**14. `LazyInitializationException` in production only.**
Different code path accessing a lazy association outside a transaction (JSON serialization of an entity). Fix: map to DTO inside the service transaction, fetch needed data, never return entities from controllers; do not rely on open-in-view.

**15. An API returns duplicate records.**
Check: a join multiplying rows (collection fetch join without `distinct`), missing unique constraints, non-idempotent creation/retries, pagination over an unstable sort order, `equals/hashCode` issues in `Set`s, duplicate Kafka processing. Investigate with SQL from logs, then fix at the source (constraint + idempotency), not with a `distinct` band-aid.

**16. A query becomes slow as data grows.**
Explain plan → missing/wrong index, function on the column, `OFFSET` pagination deep pages, non-selective index, outdated statistics, large sorts. Fix: composite index matching filter/sort, keyset pagination, covering index, archive old data, partition, cache. Measure before and after.

**17. After an upgrade, entity IDs or queries behave differently (Hibernate 5 → 6).**
Read the migration guide: default ID generation strategy and sequences changed, HQL stricter, type mapping changes. Run integration tests against a real database; compare generated SQL.

**18. Data saved but not visible to another request.**
Transaction not committed yet, wrong isolation, read replica lag, cache serving stale data, or `@Transactional(readOnly)` with a stale first-level cache in the same session. Identify which read path is used.

**19. Bulk update ran but the entity shows old values.**
The JPQL update bypasses the persistence context. Use `@Modifying(clearAutomatically = true)` or reload entities.

**20. Startup fails with a circular dependency after upgrading Spring Boot.**
Boot 2.6+ disallows it by default. Refactor (extract a shared component/event), not just `allow-circular-references=true`.

## C. API, security and design

**21. How do you securely store and rotate credentials?**
Secret manager (Vault/AWS Secrets Manager) injected at runtime; no secrets in code or images; least-privilege IAM roles; rotation with an overlap window (two valid credentials); audit and alert on access; short-lived dynamic database credentials where possible; scan repositories for leaks.

**22. A user can access another user's order by changing the id in the URL.**
IDOR / broken access control. Check ownership in the service layer (`order.getUserId().equals(currentUser)`), use `@PreAuthorize` with ownership expressions, filter queries by the user, write tests for forbidden access, return 404 or 403 consistently.

**23. Your JWT was leaked. What now?**
Short expiry limits damage; revoke the refresh token/session family; denylist the `jti`; rotate signing keys if the key leaked (publish via JWKS, support `kid`); investigate how it leaked (logs, XSS); force re-authentication; add detection (anomalous IPs).

**24. The mobile app is on version 1 and you must change an API.**
Versioning or backward-compatible additions; support old versions during a deprecation window; feature flags; contract tests; telemetry on version usage; never remove fields abruptly.

**25. How do you design an API that handles large lists?**
Pagination (keyset for large, changing datasets), maximum page size, filtering and sorting on indexed fields, streaming/export for bulk (async job + download link), consistent ordering.

**26. A downstream service is unavailable. How should your service behave?**
Timeout, limited retry with jittered backoff (idempotent calls), circuit breaker, fallback/cached data or degraded feature, queue for later processing where acceptable, clear error/`Retry-After`, alerts. Avoid blocking threads indefinitely.

**27. A file upload endpoint causes memory spikes.**
Stream to storage instead of buffering whole files; use pre-signed direct uploads; limit sizes; multipart limits; reactive/streaming APIs; check thread usage.

**28. CORS errors from the browser in production only.**
Allowed origins differ per environment; credentials with `*` origin not allowed; preflight `OPTIONS` blocked by security rules; gateway vs service both adding headers. Configure `CorsConfigurationSource` per environment and permit the preflight.

**29. How do you handle a poison message that always fails in a Kafka consumer?**
Limited retries with backoff, then publish to a dead-letter topic with error context; alert; fix and replay. Don't block the partition forever.

**30. You need to expose a public API to partners. What is your checklist?**
Authentication (OAuth2 client credentials/API keys), authorization scopes, rate limiting and quotas, input validation, versioning, documentation (OpenAPI), idempotency, webhooks with signatures, monitoring per client, SLAs, sandbox environment.

## D. Performance and production

**31. An application works locally but fails in production.** *See Part 18.12.* Compare config, data, environment, network, dependencies, concurrency, permissions.

**32. A thread pool becomes exhausted.** *See 18.5.* Thread dumps, blocking calls without timeouts, bulkheads, bounded queues.

**33. CPU is 100% after a release.** *18.2.* Hot thread → stack trace → recent change; roll back; profile.

**34. Memory grows until the pod is `OOMKilled`.** Check whether it is heap (Java OOM) or total container memory (heap + metaspace + direct buffers + thread stacks exceeding the limit). Set `MaxRAMPercentage` so the heap leaves headroom, analyse heap dump, check native memory (NMT), cap caches.

**35. Latency is fine on average but terrible at p99.** Look at GC pauses, lock contention, retries, cold caches, slow queries on specific inputs, queueing, noisy neighbours. Use histograms and traces for tail cases; averages hide them.

**36. Response time degrades only at peak hours.** Saturation (pool/thread/CPU), shared dependency limits, lock contention, cache stampede. Load test, autoscale, add back-pressure.

**37. A cache stampede takes the database down.** Many requests rebuild an expired hot key. Use per-key locks or request coalescing, jittered TTLs, refresh-ahead, serve-stale-while-revalidate.

**38. Logs are huge and costly; yet you cannot find the problem.** Structured JSON logs with correlation ids, proper levels, sample noisy logs, avoid logging payloads, central search, tracing for flow.

**39. Batch job takes 6 hours and grows.** Partition work (chunks/parallelism), keyset reads, batch inserts (`jdbc.batch_size`, sequence ids), avoid loading everything in memory, commit per chunk with restartability (Spring Batch), move heavy aggregates to the DB, schedule off-peak.

**40. How do you deploy a change without downtime?** Rolling/blue-green/canary, readiness probes, graceful shutdown, backward-compatible API and DB changes (expand/contract), feature flags, automated rollback.

## E. Microservices and architecture

**41. Service A calls B calls C; C is slow and everything times out.** Cascading failure: timeouts budget at each hop, circuit breakers, bulkheads, async decoupling, cache, reduce chattiness.

**42. How do you trace a failing request across 6 services?** Correlation/trace id propagated by headers, central logs searchable by id, distributed tracing UI to see which span failed or was slow.

**43. Data needed by service A lives in service B. Calls are chatty.** Options: API composition at the gateway/BFF, **replicate needed data via events** (local read model), merge services if the boundary is wrong. Trade-off: eventual consistency vs coupling.

**44. A shared database between services causes release problems.** Move to database-per-service with APIs/events; transitional approaches: views, then ownership of tables by one service, then extraction.

**45. You must migrate a monolith to microservices.** Strangler fig: put a gateway in front, extract capabilities one by one (start with low-risk, high-value, clear boundaries), keep data ownership in mind, build CI/CD and observability first, avoid a big-bang rewrite.

**46. Event schema must change but consumers are not ready.** Backward/forward compatible changes (add optional fields), schema registry compatibility checks, version topics for breaking changes, consumers tolerant of unknown fields.

**47. Messages arrive out of order.** Partition by entity key to keep per-entity order; version numbers/timestamps in events so consumers ignore stale ones; design handlers to be commutative or use state machines.

**48. How do you ensure a config change doesn't take the system down?** Config as code with review, validation on startup (fail fast), gradual rollout, feature flags, ability to roll back quickly, audit trail.

**49. Multi-region requirement appears. What changes?** Data replication strategy and consistency trade-offs (active-passive vs active-active), conflict resolution, global load balancing/DNS failover, latency, data residency laws, cost and operational complexity — justify with RPO/RTO needs.

**50. A third-party API has strict rate limits.** Client-side throttling (token bucket), queue requests, cache responses, batch calls, exponential backoff on 429, monitor quota usage, fallback behavior.

## F. Extra practice

**51. Your Spring Boot app starts slowly in Kubernetes and gets killed.** Startup probe/longer `initialDelay`, reduce classpath scanning/lazy init, check external dependency waits, CPU limits too low during startup, consider AOT/native or CDS.

**52. Your scheduled report exports 2 million rows and crashes.** Stream results (`Stream`/cursor with fetch size, `@QueryHints`), write to a file incrementally, run async and notify, never build the whole result in memory.

**53. `NullPointerException` appears only occasionally in production.** Look at the stack trace line, check for racing initialization, `Optional` misuse, unexpected nulls from external data/JSON, lazy fields set later; add validation at boundaries; reproduce with the exact input from logs/traces.

**54. Time-related bug: reports differ by a day for users in another country.** Store UTC `Instant`, convert at the edges with an explicit `ZoneId`, avoid `LocalDateTime` for absolute moments, beware DST; test with different zones.

**55. A new engineer asks why you chose a modular monolith over microservices.** Team size, deployment simplicity, domain boundaries not yet stable, operational cost; designed modules with clear interfaces so extraction later is possible.
