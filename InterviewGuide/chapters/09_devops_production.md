# Part 17 — DevOps, Cloud and Production Support

## 17.1 Build tools and Git

**Maven lifecycle:** `validate → compile → test → package → verify → install → deploy` (running a phase runs all earlier ones). `mvn clean package` = delete `target/`, build the JAR. **Dependency management:** transitive dependencies, `dependencyManagement`/BOMs pin versions; scopes `compile`, `provided`, `runtime`, `test`; inspect with `mvn dependency:tree`; resolve conflicts with exclusions or BOMs ("nearest wins" rule). **Gradle:** Groovy/Kotlin DSL, incremental builds and build cache make it faster on big projects; `implementation` vs `api` configurations.

**Git:**
* **merge** keeps history and creates a merge commit; **rebase** replays your commits on top of another branch for a linear history — never rebase commits others have already pulled.
* **Conflict resolution:** `git status` → edit the conflict markers → `git add` → `git rebase --continue` / `git commit`. Understand both sides' intent; run tests after.
* Branching models: trunk-based development with short-lived branches and feature flags, or GitFlow for scheduled releases. Useful commands: `git bisect` (find the commit that broke it), `git reflog` (recover lost commits), `git cherry-pick`, `git stash`, `git revert` (safe undo on shared branches).

## 17.2 Docker

```dockerfile
# Multi-stage build: small final image, non-root user, layered jar
FROM eclipse-temurin:21-jdk AS build
WORKDIR /src
COPY pom.xml mvnw ./
COPY .mvn .mvn
RUN ./mvnw -q dependency:go-offline
COPY src src
RUN ./mvnw -q package -DskipTests && java -Djarmode=tools -jar target/app.jar extract --layers --destination /layers

FROM eclipse-temurin:21-jre
RUN useradd -r -u 1001 appuser
WORKDIR /app
COPY --from=build /layers/dependencies/ ./
COPY --from=build /layers/spring-boot-loader/ ./
COPY --from=build /layers/snapshot-dependencies/ ./
COPY --from=build /layers/application/ ./
USER appuser
EXPOSE 8080
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "app.jar"]
```
*(Layer extraction syntax differs by Spring Boot version: Boot 3.3+ uses `-Djarmode=tools ... extract --layers`; earlier versions use `-Djarmode=layertools extract`. Check your version.)* **Image vs container:** an image is the immutable template; a container is a running instance. Keep images small, pin base image versions, do not bake in secrets, run as non-root, and rely on `.dockerignore`.

## 17.3 Kubernetes fundamentals

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: order-service }
spec:
  replicas: 3
  strategy: { type: RollingUpdate, rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } }
  selector: { matchLabels: { app: order-service } }
  template:
    metadata: { labels: { app: order-service } }
    spec:
      containers:
        - name: app
          image: registry.example.com/order-service:1.4.2
          ports: [{ containerPort: 8080 }]
          envFrom: [{ configMapRef: { name: order-config } }, { secretRef: { name: order-secrets } }]
          resources: { requests: { cpu: 250m, memory: 512Mi }, limits: { memory: 768Mi } }
          readinessProbe: { httpGet: { path: /actuator/health/readiness, port: 8080 }, initialDelaySeconds: 20 }
          livenessProbe:  { httpGet: { path: /actuator/health/liveness,  port: 8080 }, initialDelaySeconds: 40 }
      terminationGracePeriodSeconds: 45
```
**Key ideas:** readiness decides whether the pod receives traffic; liveness restarts a stuck pod (do not make liveness depend on downstream services, or an outage restarts everything); **requests** affect scheduling, **limits** cap usage (a memory limit exceeded causes `OOMKilled`); rolling updates replace pods gradually; a `Service` gives a stable endpoint; `HPA` scales on metrics.

## 17.4 CI/CD

A pipeline (Jenkins, GitHub Actions, GitLab CI, Azure DevOps): **checkout → build → unit tests → static analysis (Sonar, SpotBugs) → dependency/vulnerability scan → package → build and scan image → push to registry → deploy to dev/test → integration/smoke tests → approval → deploy to prod → post-deploy verification and automatic rollback**. Principles: build once, promote the same artifact through environments; configuration via environment, not rebuilds; every change goes through the pipeline; fast feedback (fail early); pipelines as code.

**Jenkins** basics: a `Jenkinsfile` (declarative pipeline) with `stages`, agents, credentials binding, shared libraries, webhooks.

**Environment-specific configuration:** Spring profiles, environment variables, ConfigMaps/Secrets, or a config server — **never** different builds per environment.

## 17.5 Deployment strategies

| Strategy | How | Pros | Cons |
|---|---|---|---|
| **Rolling** | Replace instances gradually | No extra capacity; simple | Old and new versions run together (needs backward compatibility); slow rollback |
| **Blue-green** | Two environments; switch traffic | Instant switch and rollback | Double capacity; DB changes must be compatible |
| **Canary** | Send a small percentage to the new version, watch metrics, then ramp up | Limits blast radius | Needs good metrics and traffic routing |

**Zero-downtime changes:** backward-compatible APIs; **expand/contract** database migrations (add the new column → deploy code that writes both → backfill → switch reads → drop the old column later); readiness probes; graceful shutdown (`server.shutdown=graceful`); feature flags to decouple deploy from release.

## 17.6 Logging, metrics, tracing

* **SLF4J + Logback:** program to the SLF4J API; config in `logback-spring.xml`; use levels properly (ERROR = needs action, WARN = unexpected but handled, INFO = business milestones, DEBUG = diagnostics); parameterized messages; **MDC** for `traceId`, `userId`; JSON logs for log pipelines; never log secrets or PII.
* **Metrics (Micrometer → Prometheus → Grafana):** counters, gauges, timers/histograms; JVM metrics, HTTP server metrics, `hikaricp_connections_*`, executor metrics, Kafka consumer lag. Alert on **symptoms** (error rate, latency percentiles, saturation) and use dashboards to find causes.
* **Tracing (OpenTelemetry):** spans, trace context propagation (`traceparent`), exporters to Jaeger/Tempo/Zipkin; in Boot 3 use Micrometer Tracing with an OTel bridge.
* **APM tools** (Datadog, New Relic, Dynatrace, Elastic APM, Grafana stack) combine these with profiling.

## 17.7 Cloud, secrets and TLS

* **Cloud fundamentals (AWS names; Azure/GCP have equivalents):** compute (EC2, ECS/EKS, Lambda), storage (S3), databases (RDS/Aurora, DynamoDB, ElastiCache), messaging (SQS/SNS, MSK), networking (VPC, subnets, security groups, load balancers, Route 53, CloudFront), identity (IAM — least privilege, roles instead of long-lived keys), observability (CloudWatch). Know **regions vs availability zones**, managed vs self-managed trade-offs, and the **shared responsibility model**.
* **Secrets:** Secrets Manager / Key Vault / Vault / Kubernetes Secrets (enable encryption at rest, restrict RBAC); inject at runtime; rotate (dual-valid-credentials window so rotation does not cause downtime); never commit; audit access.
* **TLS/HTTPS:** TLS gives encryption, server authentication (certificates signed by a CA) and integrity. Terminate at the load balancer/ingress or the app; use modern protocol versions; automate certificate renewal (cert-manager / Let's Encrypt / cloud certificate managers); **mTLS** for service-to-service.

---

# Part 18 — Production Incident Playbooks

General method: **(1) Stabilize** — reduce user impact first (rollback, scale out, disable a feature, shed load). **(2) Gather evidence** — dashboards, logs, traces, recent deployments/config changes. **(3) Form a hypothesis, test it.** **(4) Fix, verify.** **(5) Post-incident review** — blameless, with root cause and prevention actions. Always ask first: *"What changed?"* (deployment, config, traffic, data volume, a dependency).

Each playbook below: **investigate → tools → root causes → immediate mitigation → long-term prevention.**

## 18.1 API suddenly slow
* **Investigate:** which endpoints? since when (deploy correlation)? p50 vs p99? Check traces to see which span grew (DB, downstream, CPU, GC).
* **Tools:** APM/traces, Grafana, slow query log, `jcmd Thread.print`, GC logs.
* **Causes:** slow/missing index or changed query plan, N+1 after a code change, downstream latency, lock contention, GC pauses, connection-pool wait, noisy neighbour, cache miss storm.
* **Mitigate:** rollback, scale out, enable cache/circuit breaker, kill a runaway query. **Prevent:** load tests, query-count assertions in tests, SLO alerts, timeouts.

## 18.2 High CPU
* **Investigate:** `top -H -p <pid>` to find hot threads → convert thread id to hex → match `nid` in `jstack`; sample several dumps; use a profiler (async-profiler/JFR) for flame graphs.
* **Causes:** infinite/busy loops, regex catastrophic backtracking, excessive serialization, frequent GC (then it is really a memory problem), hot lock spinning, too many threads.
* **Mitigate:** restart the instance (after collecting dumps), scale out, disable the feature. **Prevent:** profiling in staging, regex review, back-pressure.

## 18.3 OutOfMemoryError and memory leaks
* **Investigate:** which memory (heap, metaspace, native threads)? GC logs, heap histogram, heap dump (`-XX:+HeapDumpOnOutOfMemoryError`), analyse in Eclipse MAT, find the dominator and path to GC roots. Rising old-gen after each full GC = leak.
* **Causes:** unbounded caches/collections, loading full tables into memory, listener leaks, `ThreadLocal`, large payloads, too-small container limits (`OOMKilled` by the kernel is *different* from a Java OOM — check the pod's last state).
* **Mitigate:** restart/scale, raise the heap *temporarily*. **Prevent:** bounded caches, pagination/streaming, memory alerts, load/soak tests.

## 18.4 Database connection pool exhaustion
* **Symptoms:** `HikariPool-1 - Connection is not available, request timed out after 30000ms`; latency spikes; threads waiting on `HikariPool.getConnection`.
* **Investigate:** Hikari metrics (active, pending, timeouts), `leakDetectionThreshold` warnings, DB view of active sessions/long transactions (`pg_stat_activity`), thread dump showing what threads do while holding connections.
* **Causes:** slow queries; a transaction wrapping a remote HTTP call; connection leaks (manual JDBC without close); open-in-view; `REQUIRES_NEW` nesting needing two connections per request; pool too small versus concurrency; DB lock waits.
* **Mitigate:** kill blocked sessions, restart, temporarily raise the pool (careful — the DB has a limit). **Prevent:** shorter transactions, timeouts (`statement`, lock, transaction), pool metrics and alerts, fix queries.

## 18.5 Thread pool exhaustion
* **Symptoms:** requests queue or are rejected, CPU low, latency high. **Investigate:** thread dumps (all threads `WAITING`/`BLOCKED` in the same place), executor metrics, Tomcat `server.tomcat.threads.max` usage. **Causes:** blocking calls without timeouts to a slow dependency, unbounded queues hiding the problem, deadlock, too few threads. **Mitigate:** circuit-break the dependency, restart. **Prevent:** timeouts, bulkheads (separate pools per dependency), bounded queues with rejection policies, consider virtual threads for I/O-bound loads.

## 18.6 Excessive database queries
* **Investigate:** enable SQL logging in a lower environment, `datasource-proxy`, Hibernate statistics, count queries per request in tests. **Causes:** N+1, lazy loading in loops or serialization, repeated lookups of the same data. **Fix:** fetch joins/entity graphs/batch size/projections/caching. **Prevent:** query-count tests, code review checks, DTO projections for list endpoints.

## 18.7 Kafka consumer lag
* **Investigate:** lag per partition (`kafka-consumer-groups --describe`, metrics). Is one partition lagging (hot key/skew or a stuck "poison" message) or all (slow processing/insufficient consumers)? Check rebalance storms (`max.poll.interval.ms` exceeded because processing is too slow).
* **Causes:** slow downstream call/DB in the consumer, a poison pill retried endlessly, too few partitions/consumers, frequent rebalances, a producer burst.
* **Mitigate:** scale consumers up to the partition count, increase partitions (affects key ordering), pause or skip poison messages to a DLT, tune `max.poll.records`/`max.poll.interval.ms`. **Prevent:** DLT + retry topics, idempotent processing, lag alerts, capacity planning, avoid long blocking work in the poll loop.

## 18.8 Downstream service unavailable
* **Behaviour you want:** timeouts → limited retries (idempotent calls only, with backoff + jitter) → circuit breaker opens → fallback (cached/degraded response, queue for later) → clear error to the client (`503` with `Retry-After` or `202 Accepted` for async). **Investigate:** dependency dashboards, circuit-breaker state metrics, error budgets. **Prevent:** bulkheads, SLAs/contract tests, chaos testing, async decoupling where possible.

## 18.9 HTTP 500 errors after deployment
* **Investigate:** compare error logs before/after; first stack trace; check config/secrets/feature flags; DB migration applied? incompatible API/event contract change? missing environment variable; dependency versions; readiness gate too early. **Mitigate:** **roll back first**, then debug. **Prevent:** canary releases, smoke tests, backward-compatible migrations, automated rollback on error-rate increase, contract tests.

## 18.10 Deadlocks
* **Java deadlock:** `jstack` reports "Found one Java-level deadlock" with the lock cycle; fix with consistent lock ordering/`tryLock`. **Database deadlock:** the DB log shows the victim and statements (`SHOW ENGINE INNODB STATUS`, PostgreSQL log with `log_lock_waits`). Fix with consistent update order, shorter transactions, proper indexes, retry the victim transaction.

## 18.11 Intermittent timeouts
* **Investigate:** is it correlated with a time pattern, a specific instance/pod/AZ, GC pauses, connection reuse issues (stale pooled connections killed by firewalls/load balancers → set `maxLifetime` below the idle timeout), DNS caching, cold starts, retries amplifying load, CPU throttling in containers (CFS limits), noisy neighbours, packet loss. **Tools:** traces with per-hop timings, `tcpdump`/connection metrics, per-instance dashboards, GC logs. **Prevent:** consistent timeouts budgeted across the call chain (the caller's timeout must exceed the callee's work, but the total must fit the user's patience), keepalive/health-checked pools, load tests.

## 18.12 "Works locally, fails in production"
Compare **config** (profiles, env vars, secrets), **data** (volume, nulls, encodings), **environment** (Java version, timezone, locale/charset, file paths, memory limits), **network** (firewalls, DNS, TLS certificates, proxies), **dependencies** (versions, availability), **concurrency** (only visible under load), **permissions** (IAM roles, file system). Use the Actuator `/env` and `/configprops` endpoints (secured), a debug log level toggled at runtime, and reproduce with production-like data in staging.
