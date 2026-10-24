# Part 12 — Microservices Architecture

## 12.1 Monolith vs microservices

**Simple answer:** A monolith is one deployable unit; microservices are many small, independently deployable services, each owning one business capability and its data.

| | Monolith | Microservices |
|---|---|---|
| Deployment | One unit | Per service |
| Scaling | Whole app | Per service |
| Team autonomy | Low | High |
| Complexity | In the code | In the network, ops, data consistency |
| Latency / failures | In-process calls | Network calls can fail or be slow |
| Transactions | Local ACID | Distributed → sagas |
| Debugging | One log, one stack trace | Needs tracing and central logs |

**When microservices are appropriate:** multiple teams working independently, parts of the system with very different scaling needs, a clear domain structure, and a mature DevOps culture (CI/CD, monitoring). **When not:** small team, unclear domain, early-stage product. A well-structured **modular monolith** is often the best start. Say this in an interview; it shows judgement.

**Service decomposition & DDD basics:** split by **business capability / bounded context** (a boundary within which a model and its language are consistent), not by technical layer. "Customer" in Billing differs from "Customer" in Support. **Aggregates** are consistency boundaries — keep one transaction per aggregate. Signs of bad boundaries: services that must always deploy together, chatty calls, shared database tables, distributed transactions everywhere ("distributed monolith").

## 12.2 Communication

| | Synchronous (REST/gRPC) | Asynchronous (messaging) |
|---|---|---|
| Coupling | Temporal coupling (callee must be up) | Decoupled in time |
| Latency | Immediate response | Eventual |
| Failure | Cascading failures possible | Broker buffers messages |
| Use | Queries, user waiting for answer | Events, workflows, notifications |

* **REST/JSON:** simple, universal. **gRPC:** binary Protobuf over HTTP/2, strict contracts, streaming, efficient for internal calls. **Messaging (Kafka, RabbitMQ):** events and commands.
* **Kafka vs RabbitMQ:** Kafka is a **distributed, partitioned, replicated log**: consumers pull and track offsets, messages are retained and can be replayed, great for high-throughput event streaming. RabbitMQ is a **traditional broker** with routing (exchanges/queues), push delivery, acknowledgments and per-message handling; great for task queues and complex routing.

## 12.3 Infrastructure building blocks

* **API Gateway** (Spring Cloud Gateway, Kong, NGINX, cloud gateways): single entry point; routing, authentication, rate limiting, TLS termination, request aggregation. Avoid putting business logic there.
* **Service discovery:** services register (Eureka, Consul) and are found by name; on Kubernetes, **Service DNS** does this for you.
* **Configuration management:** Spring Cloud Config, Consul, or Kubernetes ConfigMaps/Secrets.
* **Load balancing:** client-side (Spring Cloud LoadBalancer) or server-side (K8s Service, ALB).
* **Centralized logging:** ship JSON logs to ELK/OpenSearch/Loki. **Distributed tracing:** OpenTelemetry/Micrometer Tracing → Zipkin/Jaeger/Tempo; a **trace id** follows a request across services (propagated in headers like `traceparent`), spans show time per hop. **Correlation id** ties logs together.
* **Health checks:** liveness (restart me?) vs readiness (send me traffic?).
* **Service-to-service authentication:** mTLS (often via service mesh like Istio/Linkerd) and/or OAuth2 client-credentials tokens. Never trust "internal network = safe".

## 12.4 Resilience patterns

Calls to other services *will* fail or hang. Protect yourself:

* **Timeouts:** every remote call needs one. The most common cause of cascading failure is a missing timeout.
* **Retry with exponential backoff and jitter:** retry only **idempotent** operations and transient errors; add random jitter so clients do not retry in lockstep (a "retry storm" can crush a recovering service).
* **Circuit breaker:** after many failures the circuit **opens** and calls fail fast (or use a fallback), then goes **half-open** to probe recovery, then **closed**. Protects threads and the downstream service.
* **Bulkhead:** isolate resources (separate thread pools/semaphores per dependency) so one slow dependency cannot consume everything.
* **Rate limiter / load shedding:** protect yourself from overload.
* **Fallbacks:** cached data, default values, degraded features.

```java
@Service
class PricingClient {
    private final RestClient http;
    PricingClient(RestClient http) { this.http = http; }

    @CircuitBreaker(name = "pricing", fallbackMethod = "cachedPrice")
    @Retry(name = "pricing")
    @TimeLimiter(name = "pricing")      // for async types; for blocking calls set HTTP client timeouts instead
    public Price price(String sku) { return http.get().uri("/prices/{sku}", sku).retrieve().body(Price.class); }

    Price cachedPrice(String sku, Throwable t) { return Price.unknown(sku); }
}
```
```yaml
resilience4j:
  circuitbreaker.instances.pricing:
    slidingWindowSize: 20
    failureRateThreshold: 50
    waitDurationInOpenState: 15s
  retry.instances.pricing:
    maxAttempts: 3
    waitDuration: 200ms
    enableExponentialBackoff: true
    exponentialBackoffMultiplier: 2
    enableRandomizedWait: true
```
(Resilience4j via `resilience4j-spring-boot3`. The numbers above are illustrative settings, not recommendations — tune from real traffic.)

## 12.5 Data consistency across services

**Database per service:** each service owns its schema; others access data only through APIs/events. This gives autonomy but removes cross-service joins and ACID transactions.

**Saga pattern:** a business transaction is a sequence of local transactions; if a step fails, **compensating transactions** undo previous steps.

* **Orchestration:** a central coordinator (an Order Orchestrator or a workflow engine such as Temporal/Camunda) tells each service what to do. Easier to understand and monitor; the orchestrator is a coupling point.
* **Choreography:** services react to each other's events. No central brain, loosely coupled, but the flow is hard to see and cyclic dependencies creep in.

```text
Order placed -> Inventory reserves stock -> Payment charges -> Order confirmed
 Failure at Payment: -> Inventory releases stock (compensation) -> Order cancelled
```
Compensation is a *business* undo (refund, release), not a database rollback; steps must be idempotent.

**Transactional outbox pattern** (solves "update DB **and** publish an event atomically", the dual-write problem):

1. In **one local transaction**, update the business table and insert a row into an `outbox` table.
2. A relay (a poller, or CDC with Debezium) reads the outbox and publishes to Kafka, marking rows as sent.
3. The relay may publish a message more than once (at-least-once) → consumers must be **idempotent**.

```java
@Transactional
public void placeOrder(OrderRequest r) {
    Order o = orderRepo.save(Order.from(r));
    outboxRepo.save(new OutboxEvent("OrderPlaced", o.getId().toString(), toJson(o)));   // same TX
}
```

**Idempotent consumer:** record processed message ids (a `processed_messages` table with a unique key) in the **same transaction** as the business effect, or make the effect naturally idempotent (upsert, "set status = PAID" rather than "add 100").

**Eventual consistency:** after a change, different services converge to a consistent state *after a delay*. Design UX and APIs for it (pending states, polling/notifications).

**CQRS:** separate the **write model** (commands, validations) from the **read model** (denormalized views optimized for queries), usually synchronized with events. Benefits: scale reads independently, tailor views. Cost: complexity, eventual consistency. **Event sourcing:** store the sequence of events as the source of truth and rebuild state by replaying; gives audit history and temporal queries, but brings schema-evolution, snapshotting, and query complexity. Use only when the benefits are needed.

**Distributed locking:** Redis (`SET key value NX PX ttl`, Redisson, RedLock debates), database row locks, ZooKeeper/etcd. Locks need **TTLs**, and correctness-critical work should use **fencing tokens** or database constraints rather than trusting a lock alone.

## 12.6 Kafka fundamentals

* **Topic** is a named log split into **partitions**; each partition is an ordered, append-only sequence with **offsets**. **Ordering is guaranteed only within a partition**, so use the same **key** (e.g., `orderId`) to keep related events in order.
* **Producer** chooses the partition (by key hash). **Consumer group:** partitions are divided among consumers in a group; max parallelism = number of partitions. Different groups each get all messages.
* **Replication:** each partition has a leader and followers (`replication.factor`); `acks=all` + `min.insync.replicas` for durability. **Producer idempotence** (`enable.idempotence=true`) prevents duplicates from retries.
* **Delivery semantics:** **at-most-once** (may lose), **at-least-once** (may duplicate — the common default with manual/after-processing commits), **exactly-once** (Kafka transactions within Kafka-to-Kafka flows; end-to-end exactly-once with external side effects still requires idempotent handling).
* **Duplicates:** arise from producer retries, consumer rebalances, and crashes before committing offsets. Defence = idempotent processing.
* **Dead-letter topic (DLT):** messages that fail after retries are routed to a DLT for inspection/replay instead of blocking the partition. Spring Kafka: `DefaultErrorHandler` + `DeadLetterPublishingRecoverer`, and `@RetryableTopic`.
* **Schema evolution:** use a schema registry (Avro/Protobuf/JSON Schema) and compatibility rules (backward/forward/full); add optional fields, never reuse or retype fields.
* **Consumer lag:** the gap between the latest offset and the consumer's committed offset; the key health metric.

```java
@Component
class OrderEventsConsumer {
    private final ProcessedMessageRepo processed; private final ShipmentService shipments;

    @KafkaListener(topics = "orders.placed", groupId = "shipping")
    @Transactional
    public void on(ConsumerRecord<String, OrderPlaced> rec) {
        String id = rec.topic() + "-" + rec.partition() + "-" + rec.offset();   // or a business event id in the payload
        if (!processed.markIfNew(id)) return;           // unique-key insert; duplicate => skip
        shipments.createFor(rec.value());
    }
}
// spring.kafka.consumer.enable-auto-commit=false ; ack-mode record/batch after processing
```

## 12.7 Caching and Redis

* **Cache-aside** (most common): read cache → on miss, read DB and populate. Writes: update the DB then **invalidate** the cache entry. **Write-through/write-behind** are alternatives.
* **Spring Cache:** `@Cacheable("products")`, `@CacheEvict`, `@CachePut` (proxy-based, so the same self-invocation caveat applies).
* **Redis:** in-memory key-value store; data structures (strings, hashes, sets, sorted sets, streams); TTLs; used for caching, sessions, rate limiting, distributed locks, leaderboards.
* **Problems:** stale data; **cache stampede** (many requests rebuild a hot key at once → use per-key locking, request coalescing, jittered TTLs); **cache penetration** (queries for non-existent keys → cache negative results/Bloom filter); **hot keys**; memory eviction policy (`allkeys-lru`).
* **Distributed caches** need serialization strategy and versioned keys.

## 12.8 Containers and Kubernetes basics

* **Docker:** package app + runtime into an image; containers are isolated processes.
* **Kubernetes:** orchestrates containers. **Pod** (one or more containers), **Deployment** (desired replicas, rolling updates), **Service** (stable network name/load balancing), **Ingress** (HTTP routing), **ConfigMap/Secret**, **HPA** (autoscaling), **liveness/readiness/startup probes**, **resource requests/limits**.

## 12.9 Realistic architecture walkthrough: Clinic Appointment Platform

```text
 Mobile/Web --> API Gateway (auth, rate limit, routing)
                  |-- User Service -----------> users DB
                  |-- Clinic Service ---------> clinics/doctors/slots DB  (+ Redis cache for slot lists)
                  |-- Appointment Service ----> appointments DB (+ outbox)
                  |-- Payment Service --------> payments DB  --> external payment provider
                  '-- Notification Service ---> email/SMS/push providers
 Kafka: appointment.requested, slot.reserved, payment.completed/failed, appointment.confirmed/cancelled
 Service Registry/DNS, Config server, Central logging, Tracing (OpenTelemetry), Metrics (Prometheus)
```

**Request flow (book an appointment, orchestrated saga):**

1. Client → Gateway (JWT validated) → `POST /appointments {doctorId, slotId}` with an `Idempotency-Key`.
2. **Appointment Service** creates `Appointment(PENDING)` and writes `AppointmentRequested` to the outbox in one TX; returns `202/201` with a status link.
3. The orchestrator (or choreographed events) asks **Clinic Service** to **reserve the slot** (conditional update: `UPDATE slots SET status='HELD' WHERE id=? AND status='FREE'`; 0 rows → slot taken).
4. On success → **Payment Service** charges (with idempotency key to the provider).
5. On payment success → Appointment `CONFIRMED` → event → **Notification Service** sends confirmation.
6. On payment failure/timeout → compensation: release the slot, mark `CANCELLED`, notify.

**Failure scenarios:**

| Failure | Handling |
|---|---|
| Two users book the same slot | Atomic conditional update or unique constraint `(doctor_id, slot_time)`; loser gets 409 |
| Payment service down | Circuit breaker, slot hold expires after TTL, appointment stays `PENDING_PAYMENT`, retry or cancel |
| Payment succeeded but event lost | Outbox guarantees publishing; reconciliation job compares provider records vs DB |
| Notification provider down | Retry with backoff, DLT; notification failure must not fail the booking |
| Duplicate Kafka event | Idempotent consumer |
| Gateway or one instance dies | Multiple replicas + readiness probes |
| Slot hold never released | Scheduled expiry job + TTL |

**Consistency:** each service is strongly consistent internally and **eventually consistent** across services. **Trade-offs:** more moving parts, harder debugging, need for tracing and reconciliation versus independent scaling and team autonomy.

## 12.10 Observability and production troubleshooting

Three pillars: **logs** (what happened), **metrics** (how much/how fast: RED = Rate, Errors, Duration; USE = Utilization, Saturation, Errors), **traces** (where time went). Define **SLIs/SLOs** and alert on symptoms (error rate, latency) rather than only causes. Add dashboards per service: request rate, p95/p99 latency, error rate, JVM memory/GC, thread pools, DB pool, Kafka lag.

**Interview-ready answer (microservices in general):** "I start with business capabilities and bounded contexts, give each service its own data, communicate synchronously for queries and asynchronously for events, and design for failure with timeouts, retries with jitter, circuit breakers and idempotency. For cross-service workflows I use sagas with an outbox so state and events never diverge. And I invest in observability early, because without it microservices are undebuggable. I'd only choose microservices when the organization is big enough to benefit; otherwise a modular monolith."
