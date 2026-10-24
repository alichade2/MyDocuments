# Part 15 — Design Patterns and Clean Code

For each pattern: **problem → analogy → Java/Spring use → when NOT to use.**

## 15.1 Singleton
**Problem:** exactly one instance (configuration, registry). **Analogy:** a country has one president at a time. **Best Java form:** an `enum` singleton, or the holder idiom (Part 7). In Spring, make the bean singleton-scoped and inject it — do not hand-write `getInstance()`. **Avoid when:** it carries mutable global state, hurts testing, or hides dependencies.

## 15.2 Factory Method and Abstract Factory
**Problem:** decouple object creation from usage. **Analogy:** a restaurant kitchen makes the dish; you only order by name.

```java
interface Notifier { void send(String to, String msg); }
class EmailNotifier implements Notifier { public void send(String t, String m) { /* SMTP */ } }
class SmsNotifier implements Notifier { public void send(String t, String m) { /* SMS */ } }
class NotifierFactory {
    static Notifier create(String channel) {
        switch (channel) { case "EMAIL": return new EmailNotifier(); case "SMS": return new SmsNotifier();
                           default: throw new IllegalArgumentException(channel); }
    }
}
```
**Spring version:** inject `Map<String, Notifier>` — Spring fills the map with bean name → bean — and look up by key (no `switch`). **Abstract Factory** creates *families* of related objects (e.g., a UI toolkit's Button+Checkbox for Windows vs Mac). **Avoid when:** only one implementation exists.

## 15.3 Builder
**Problem:** many optional parameters; avoid telescoping constructors. **Analogy:** ordering a custom sandwich step by step.

```java
public final class Order {
    private final String id; private final String customer; private final String coupon;
    private Order(Builder b) { id = b.id; customer = b.customer; coupon = b.coupon; }
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String id, customer, coupon;
        public Builder id(String v) { id = v; return this; }
        public Builder customer(String v) { customer = v; return this; }
        public Builder coupon(String v) { coupon = v; return this; }
        public Order build() { if (id == null || customer == null) throw new IllegalStateException("id/customer required"); return new Order(this); }
    }
}
```
Lombok `@Builder` generates this; `StringBuilder`, `Stream.Builder`, Spring's `RestClient.Builder` use it. **Avoid when:** the object has 2–3 simple fields (a constructor or record is clearer).

## 15.4 Strategy
**Problem:** swap algorithms at runtime. **Analogy:** choosing a route (fastest, cheapest) in a maps app. Replaces long `if/else` chains.

```java
interface PricingStrategy { BigDecimal price(BigDecimal base); }
@Component("regular") class Regular implements PricingStrategy { public BigDecimal price(BigDecimal b) { return b; } }
@Component("premium") class Premium implements PricingStrategy { public BigDecimal price(BigDecimal b) { return b.multiply(new BigDecimal("0.90")); } }

@Service class Checkout {
    private final Map<String, PricingStrategy> strategies;                // Spring injects all beans by name
    Checkout(Map<String, PricingStrategy> strategies) { this.strategies = strategies; }
    BigDecimal total(String tier, BigDecimal base) { return strategies.getOrDefault(tier, strategies.get("regular")).price(base); }
}
```
In Java 8+, a strategy can simply be a lambda/`Function`. **Avoid when:** there is only one variant that never changes.

## 15.5 Observer
**Problem:** notify many dependents when something changes. **Analogy:** newsletter subscription. **Java/Spring:** Spring application events (`ApplicationEventPublisher` + `@EventListener`), Kafka topics (distributed observer), `java.util.Observer` is deprecated. **Avoid when:** order of notification or guaranteed delivery matters and you use plain in-memory listeners (they are synchronous by default, and failures can break the publisher; use `@Async` or a message broker).

## 15.6 Decorator
**Problem:** add behaviour dynamically without subclass explosion. **Analogy:** adding toppings to a pizza. **Java:** `new BufferedReader(new InputStreamReader(in))`, `Collections.unmodifiableList`. **Spring:** wrapping a `PaymentGateway` with a `LoggingPaymentGateway` / `CachingPaymentGateway` that implements the same interface and delegates. AOP achieves a similar effect. **Avoid when:** many layers make debugging hard.

## 15.7 Adapter and Facade
* **Adapter** converts one interface into another that the client expects. *Analogy:* a travel plug adapter. Use it to wrap a third-party SDK/legacy API behind your own interface (an `ACL`, anti-corruption layer).
* **Facade** provides a simple interface to a complex subsystem. *Analogy:* a hotel front desk. `OrderFacade.checkout()` coordinates inventory, payment and shipping calls. **Avoid** making the facade a god class.

## 15.8 Proxy
**Problem:** control access to an object (lazy loading, security, caching, transactions). **Analogy:** a receptionist in front of a manager. **Spring:** `@Transactional`, `@Cacheable`, `@Async`, security are all implemented with proxies (Part 8). Hibernate lazy entities are proxies. **Watch for:** self-invocation and `final` methods.

## 15.9 Template Method
**Problem:** fixed skeleton, variable steps. **Analogy:** a recipe where "bake" differs per cake.

```java
abstract class ReportJob {
    public final void run() { List<String> rows = fetch(); String out = format(rows); deliver(out); }
    protected abstract List<String> fetch();
    protected abstract String format(List<String> rows);
    protected void deliver(String out) { System.out.println(out); }          // hook with a default
}
```
Spring's `JdbcTemplate`, `RestTemplate` use the *template* idea (with callbacks). **Prefer composition (Strategy)** when subclassing becomes rigid.

## 15.10 Chain of Responsibility
**Problem:** pass a request along handlers until one handles it. **Analogy:** a support ticket escalating from L1 to L2 to L3. **Java:** servlet `FilterChain`, Spring Security's filter chain, validation pipelines, approval workflows.

## 15.11 Repository, DI, MVC, Circuit Breaker
* **Repository:** an abstraction of a collection of aggregates hiding persistence (`ProductRepository`). Benefits: testable, swap storage. Pitfall: leaking JPA types/queries into the domain, or generic repositories everywhere.
* **Dependency Injection:** Part 8. **MVC:** Model (data), View (presentation), Controller (handles input); in REST apps the "view" is the JSON representation.
* **Circuit Breaker:** Part 12; originated as a resilience pattern and is implemented by Resilience4j.

## 15.12 Clean code, refactoring and code reviews

* **Naming:** reveal intent (`isEligibleForRefund`), avoid abbreviations. **Small functions** that do one thing at one level of abstraction. Few parameters. No hidden side effects. Prefer immutability. Comments explain *why*, not *what*.
* **Refactoring:** change structure without changing behaviour, in small steps, protected by tests. Typical moves: extract method/class, rename, replace conditional with polymorphism, introduce parameter object, remove duplication.
* **Anti-patterns:** God object, spaghetti code, copy-paste programming, golden hammer (one tool for everything), premature optimization, magic numbers, shotgun surgery (one change touches many classes), anemic domain model, **distributed monolith**, catching `Exception` and ignoring it, N+1 in loops, logging sensitive data.
* **Code review checklist:** correctness and edge cases; tests; readability and naming; error handling and logging; security (validation, authorization, secrets); performance risks (queries in loops, unbounded results); backward compatibility; transactions and concurrency; observability. Review the *design* first, nitpicks last; be kind and specific; automate style with linters/formatters so humans focus on logic.

---

# Part 16 — System Design Interviews

## 16.1 A framework you can follow every time

1. **Clarify requirements.** *Functional* (what the system does) and *non-functional* (scale, latency, availability, consistency, durability, security, cost). Ask who the users are and what the peak load is.
2. **Estimate capacity** (rough math, state assumptions; do not pretend precision). Example: assume 100M new URLs/month → about 40 writes/sec average; reads 100× → ~4,000 reads/sec average, peaks higher. Storage = items × size × retention.
3. **Define APIs** (endpoints, request/response, idempotency, pagination).
4. **Model data** (entities, relationships, access patterns → choose the database and indexes).
5. **Draw the high-level design** (clients, gateway, services, DB, cache, queue).
6. **Deep dive** into the hard parts (hot spots, consistency, failure handling).
7. **Scale and harden:** caching, replication, partitioning/sharding, async processing, rate limiting, observability, security, cost.
8. **State trade-offs** explicitly.

**Key concepts:**
* **Horizontal vs vertical scaling:** add more machines (needs stateless services, load balancing) vs a bigger machine (simple, has a ceiling and single point of failure).
* **Load balancing:** round-robin, least connections, consistent hashing (for caches/shards). L4 vs L7.
* **Caching layers:** browser/CDN → API gateway → application cache (Redis/Caffeine) → DB buffer cache. Invalidation is the hard part.
* **Replication:** leader/follower for read scaling and availability; leader election for failover. **Partitioning/sharding:** pick a shard key with even distribution and good query locality (avoid hot shards); **consistent hashing** limits data movement when nodes change.
* **CAP theorem:** during a network **P**artition, a distributed store must choose **C**onsistency (refuse/slow some requests) or **A**vailability (answer, possibly stale). It is *not* "pick 2 of 3" at all times. **PACELC** adds: otherwise (no partition), trade **L**atency vs **C**onsistency. Money movement usually favours consistency; feeds and view counters favour availability.
* **Reliability:** redundancy, health checks, retries with backoff, timeouts, circuit breakers, graceful degradation, backups and tested restores, multi-AZ deployment, defined RPO/RTO.
* **Security:** TLS, authentication/authorization, input validation, encryption at rest, least privilege, audit logs, rate limiting, secrets management.
* **Cost/performance trade-offs:** caches and replicas cost money; async processing trades latency for throughput; over-engineering costs time.

## 16.2 Design: URL shortener

* **Requirements:** create short link, redirect fast, optional expiry/custom alias, analytics; read-heavy; high availability for redirects.
* **API:** `POST /api/v1/urls {longUrl, expiresAt?, alias?}` → `201 {shortCode}`; `GET /{code}` → `301/302` redirect (302 if you need to count every click; 301 can be cached by browsers).
* **ID generation:** (a) counter/sequence → Base62-encode (7 chars give 62⁷ ≈ 3.5 trillion codes) — predictable unless shuffled; (b) random code + unique-constraint retry on collision; (c) hash of URL (collisions, same URL → same code). A distributed counter service or pre-allocated ID ranges per app instance avoids a single bottleneck.
* **Schema:** `urls(code PK, long_url, created_at, expires_at, owner_id)`; `clicks` in an append-only store/stream, aggregated asynchronously.
* **Architecture:**

```text
Client -> CDN/LB -> Redirect Service --(cache hit)--> Redis
                         | miss                         ^
                         v                              |
                    KV/SQL store (code -> url) ---------+
Create Service -> ID generator -> store ;  click events -> Kafka -> analytics store
```
* **Bottlenecks:** hot links (cache + CDN), DB reads (cache-aside with TTL), writes (batch IDs). **Failure:** cache down → DB can take the load temporarily (protect with rate limits); ID service down → pre-fetched ranges. **Trade-offs:** 301 vs 302; SQL vs key-value store; predictable vs random codes (enumeration risk).
* **Follow-ups:** custom aliases, abuse/malware scanning, expiry cleanup, multi-region, analytics accuracy.

## 16.3 Design: E-commerce order processing

* **Services:** Catalog, Cart, Order, Inventory, Payment, Shipping, Notification; Gateway; Kafka.
* **API:** `POST /orders` (with `Idempotency-Key`), `GET /orders/{id}`, `POST /orders/{id}/cancel`.
* **Data:** `orders(id, user_id, status, total, created_at)`, `order_items`, `inventory(sku, available, reserved)`, `payments(id, order_id, status, provider_ref)`, `outbox`.
* **Flow (saga):** Order `PENDING` → reserve stock → charge payment → `CONFIRMED` → ship → notify. Failures compensate (release stock, refund, `CANCELLED`).
* **Overselling:** atomic conditional update `UPDATE inventory SET available = available - ? WHERE sku=? AND available >= ?`, or a reservation with TTL. Flash sales: queue requests, rate-limit, pre-warm caches, reserve in Redis then reconcile.
* **Bottlenecks:** hot SKUs, payment latency (async confirmation via webhook), search load (use a search index like Elasticsearch/OpenSearch fed by events). **Failure/consistency:** outbox + idempotent consumers; reconciliation jobs for payments; exactly-once *effect*, not exactly-once delivery.
* **Follow-ups:** partial shipments, returns, coupons, multi-currency, price changes between cart and checkout (snapshot prices on the order).

## 16.4 Design: Online appointment booking

* **Core invariant:** a doctor's time slot has at most one confirmed booking.
* **Schema:** `slots(id, doctor_id, start_time, end_time, status)`, `UNIQUE(doctor_id, start_time)`, `appointments(id, slot_id UNIQUE, patient_id, status, version)`.
* **Prevent double booking:** (1) unique constraint on `slot_id` in `appointments` — the database is the final judge; (2) conditional update `UPDATE slots SET status='BOOKED' WHERE id=? AND status='FREE'` (check affected rows); (3) optimistic lock `@Version`; (4) `SELECT ... FOR UPDATE` pessimistic lock for a short critical section. Return 409 to the loser.
* **Flow:** search slots (cached, short TTL) → hold slot (expires in N minutes) → payment → confirm → reminders via a scheduler/queue.
* **Time zones:** store UTC, display in the clinic's zone; recurring availability needs care with daylight-saving changes.
* **Scale:** read-heavy search (cache/search index), partition by doctor or clinic. **Failures:** abandoned holds (expiry job), notification failures (retry, never block booking).

## 16.5 Design: Payment processing

* **Principles:** correctness over speed; **idempotency keys**; an **immutable ledger** (double-entry: every movement is a pair of debit/credit entries); state machine `CREATED → AUTHORIZED → CAPTURED → REFUNDED/FAILED`.
* **Flow:** client sends a payment with an idempotency key → payment service stores intent → calls the provider (timeouts!) → handles the response or webhook → updates state + ledger in one transaction → emits an event via the outbox.
* **Uncertain outcomes:** on a timeout you do not know if the charge happened. Do **not** blindly retry with a new key; retry with the *same* idempotency key or query the provider, and run a **reconciliation** job comparing provider settlement reports with your ledger.
* **Security/compliance:** never store raw card data yourself — use a PCI-compliant provider's tokenization; encrypt, audit, least privilege. Money as `BigDecimal` or integer minor units, never `double`.
* **Failure scenarios:** duplicate webhooks (idempotent handler), webhook arrives before the API response, partial failures between ledger and event (outbox), provider downtime (circuit breaker + queue + "pending" state).

## 16.6 Design: Notification service

* **Requirements:** email/SMS/push, templates, user preferences, retries, rate limits, high volume, at-least-once with deduplication.
* **Architecture:** producers publish `NotificationRequested` events to Kafka → Notification Service validates preferences/quiet hours → renders the template → channel workers (email/SMS/push) call providers → status events/webhooks update delivery status.
* **Design points:** separate queues per channel and priority (OTP SMS must not wait behind marketing mail); retries with exponential backoff and jitter, dead-letter queue; **idempotency key** per notification to avoid duplicates; per-provider rate limits and failover to a backup provider; unsubscribe/consent handling; PII handling; scheduling.
* **Trade-offs:** at-least-once delivery means a rare duplicate; exactly-once to a human is not achievable, so make messages tolerant of duplicates.

## 16.7 Design: Rate limiter

* **Algorithms:** **fixed window** (simple, burst at window edges); **sliding window log** (accurate, memory-heavy); **sliding window counter** (approximation); **token bucket** (allows bursts up to bucket size at a steady refill rate — common default); **leaky bucket** (smooth output).
* **Where:** API gateway (per API key/IP/user), plus protective limits inside services.
* **Distributed implementation:** Redis with an atomic Lua script (or `INCR` + `EXPIRE`) keyed by client id and window. Return `429 Too Many Requests` with `Retry-After` and `X-RateLimit-*` headers.
* **Trade-offs:** local in-memory limiters are fast but inaccurate across many instances; Redis is accurate but is a dependency — decide fail-open vs fail-closed if Redis is down (usually fail-open for general APIs, fail-closed for sensitive operations).

```java
// In-memory token bucket (single instance)
final class TokenBucket {
    private final long capacity; private final double refillPerSec; private double tokens; private long last = System.nanoTime();
    TokenBucket(long capacity, double refillPerSec) { this.capacity = capacity; this.refillPerSec = refillPerSec; this.tokens = capacity; }
    synchronized boolean tryAcquire() {
        long now = System.nanoTime();
        tokens = Math.min(capacity, tokens + (now - last) / 1e9 * refillPerSec);
        last = now;
        if (tokens >= 1) { tokens -= 1; return true; }
        return false;
    }
}
```

## 16.8 Design: File upload service

* **Large files:** don't pass bytes through your app servers. Issue a **pre-signed URL** so the client uploads directly to object storage (S3/GCS/Azure Blob); use **multipart/resumable uploads** for big files.
* **Flow:** client requests an upload → service creates a metadata record `UPLOADING` and returns the pre-signed URL → client uploads → storage event notifies the service → virus scan/validation/thumbnail pipeline → record `AVAILABLE`.
* **Data:** metadata in SQL (`files(id, owner, name, size, content_type, checksum, status, storage_key)`), bytes in object storage, access via signed download URLs/CDN.
* **Concerns:** size/type limits, content sniffing, malware scanning, checksum verification, private by default, cleanup of abandoned uploads (lifecycle rules), deduplication by hash, encryption at rest.

## 16.9 Design: Employee management system

* **Entities:** Employee, Department, Position, LeaveRequest, Attendance, Payroll; self-reference `manager_id` for the hierarchy (recursive CTE for the org chart).
* **API:** CRUD on `/employees` with filters/pagination, `/employees/{id}/leaves`, approval endpoints.
* **Security:** roles (EMPLOYEE, MANAGER, HR, ADMIN) plus ownership rules (managers only see their reports); field-level protection of salary/PII; audit logging of changes.
* **Scale:** modest traffic, so a well-built modular monolith with PostgreSQL is the right answer; add caching for org data and async jobs for payroll runs. Showing this restraint is itself a senior signal.

## 16.10 Follow-up questions a senior interviewer may ask

* How would you handle 10× traffic? What breaks first?
* How do you design for zero downtime deployments and schema changes?
* How do you migrate this to multiple regions? What consistency do you give up?
* How do you test and monitor this? What are your SLOs and alerts?
* What would you simplify if the team was three people?
* What is the data retention / privacy (GDPR-like deletion) story?
