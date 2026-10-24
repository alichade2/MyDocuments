# Part 21 — Frequently Asked Comparison Questions

## 21.1 Java core

| Topic | A | B | Use cases / pitfalls |
|---|---|---|---|
| **JDK vs JRE vs JVM** | JDK = tools + JRE | JRE = JVM + libraries; JVM = executes bytecode | Develop with the JDK; JVM is platform specific. Pitfall: "JVM is platform independent" is wrong |
| **String / StringBuilder / StringBuffer** | String immutable | Builder fast, not thread-safe; Buffer synchronized | Concatenation in loops → StringBuilder |
| **ArrayList vs LinkedList** | Array, O(1) get | Linked nodes, O(n) get | ArrayList almost always; ArrayDeque for queues |
| **HashMap vs ConcurrentHashMap** | Not thread-safe, allows null | Thread-safe per-operation, no null | Check-then-act still needs `putIfAbsent`/`compute` |
| **HashMap vs TreeMap** | O(1) average, unordered | O(log n), sorted, range queries | TreeMap when ordering/ranges matter |
| **Comparable vs Comparator** | Natural order inside the class | External, multiple orderings | Use `Integer.compare` not subtraction |
| **map() vs flatMap()** | One-to-one | One-to-many, flatten | `Optional.flatMap` avoids `Optional<Optional<T>>` |
| **orElse() vs orElseGet()** | Always evaluates the argument | Evaluates only if empty | `orElseGet` for expensive/side-effect defaults |
| **Checked vs unchecked** | Compiler-forced handling | `RuntimeException`, optional | Spring: unchecked by default; rollback differs |
| **Abstract class vs interface** | State + constructors, single inheritance | Contract, multiple, default methods | Interface for capabilities; abstract for shared code |
| **synchronized vs volatile** | Atomicity + visibility + lock | Visibility only | `volatile` for flags; `count++` needs atomics/locks |
| **Runnable vs Callable** | No result, no checked exception | Returns value, may throw | Callable with `ExecutorService.submit` |
| **Future vs CompletableFuture** | Blocking `get()` | Chaining, callbacks, combine | Provide your own executor for blocking work |

Example for `orElse` vs `orElseGet`:

```java
String v1 = opt.orElse(expensiveLookup());          // expensiveLookup() runs EVERY time
String v2 = opt.orElseGet(() -> expensiveLookup()); // runs only if empty
```

## 21.2 Spring, REST and JPA

| Topic | A | B | Notes |
|---|---|---|---|
| **Spring vs Spring Boot** | Framework (IoC, MVC, TX) | Opinionated setup: auto-config, starters, embedded server, Actuator | Boot is built on Spring, not a replacement |
| **@Component vs @Bean** | Class-level, scanned | Method-level in `@Configuration`, for third-party/complex creation | Both end up as beans |
| **@Controller vs @RestController** | Returns views | `@Controller` + `@ResponseBody` → JSON | Use RestController for APIs |
| **@RequestParam vs @PathVariable** | Query string/filters | URI path identifies the resource | `/users/5?active=true` |
| **@Bean vs @Autowired** | *Defines* a bean | *Requests* a bean (injection point) | Opposite directions: provider vs consumer |
| **@Qualifier vs @Primary** | Explicit choice at the injection point | Default among candidates | Qualifier wins |
| **Lazy vs eager loading** | Load on access (needs session) | Load immediately | Default to LAZY; fetch per use case |
| **save() vs saveAndFlush()** | Schedules at flush/commit | Flushes immediately | Rarely need flush; useful before native queries or to see constraint errors early |
| **JPA vs Hibernate** | Specification | Implementation | Spring Data JPA adds repositories |
| **JDBC vs JPA** | Manual SQL, full control | ORM: mapping, caching, dirty checking | JDBC/jOOQ for complex SQL or bulk ops |
| **findById vs getReferenceById** | Query now, `Optional` | Lazy proxy, no query | Reference is handy to set FKs |
| **@Valid vs @Validated** | Jakarta, nested validation | Spring, groups + method validation | Controller param validation needs `@Validated` on the class |
| **PUT vs PATCH vs POST** | PUT replaces (idempotent) | PATCH partial; POST creates/actions | |
| **Filter vs Interceptor** | Servlet-level | Spring MVC-level | Security = filters |

**`@Transactional` propagation summary**

| Type | One-line behaviour |
|---|---|
| REQUIRED | Join or create |
| REQUIRES_NEW | Always a new independent transaction |
| SUPPORTS | Join if present, else none |
| NOT_SUPPORTED | Suspend, run without |
| MANDATORY | Must already exist |
| NEVER | Must not exist |
| NESTED | Savepoint within the current transaction |

## 21.3 Architecture and tooling

| Topic | A | B | Use cases / pitfalls |
|---|---|---|---|
| **Monolith vs microservices** | Simple deploy, local transactions | Independent scaling/teams, distributed complexity | Start modular; split when pain justifies it |
| **REST vs messaging** | Request/response, simple | Async, decoupled, resilient | REST for queries; events for workflows |
| **Kafka vs RabbitMQ** | Distributed log, replay, throughput, partition ordering | Smart broker, routing, per-message ack | Event streaming → Kafka; task queues/routing → RabbitMQ |
| **SQL vs NoSQL** | Schema, joins, ACID | Flexible schema, specific scaling/access patterns | Choose by access pattern and consistency needs |
| **Optimistic vs pessimistic locking** | Version check at write; retry on conflict | Lock rows up front | Low contention → optimistic; hot rows → pessimistic |
| **Authentication vs authorization** | Who are you? (401) | What can you do? (403) | |
| **OAuth 2.0 vs JWT** | Authorization protocol | Token format | OAuth tokens may be JWTs or opaque |
| **Unit vs integration tests** | One class, mocks, fast | Multiple components/real DB | Pyramid: many unit, fewer integration |
| **Docker vs Kubernetes** | Packages/runs containers | Orchestrates containers across machines | K8s needs images from Docker/OCI builds |
| **gRPC vs REST** | Binary, contracts, streaming | Text JSON, universal | gRPC internally; REST publicly |
| **Orchestration vs choreography (sagas)** | Central coordinator | Event reactions | Orchestration for complex flows |
| **Rolling vs blue-green vs canary** | Gradual replace | Instant switch | Canary for risk control |
| **Process vs thread** | Isolated memory | Shared heap in one process | Threads need synchronization |
| **Heap vs stack** | Objects, GC | Frames, locals per thread | SOE vs OOM |
| **Fail-fast vs weakly consistent iterators** | Throw CME on modification | Never throw; may miss/see updates | ConcurrentHashMap / CopyOnWrite |

---

# Part 22 — Final Revision Checklist and Rapid-Fire Questions

## 22.1 One-page memory aids

* **Java:** equals/hashCode contract; String pool; HashMap (bucket, hash, treeify, resize); immutability; Optional rules; streams are lazy; checked vs unchecked.
* **Concurrency:** race → atomics/locks; `volatile` is visibility only; deadlock = consistent order; bounded pools; `CompletableFuture` with your executor; virtual threads for blocking I/O.
* **JVM:** heap (young/old), stack, Metaspace; G1 default; leaks = reachable but unused; heap dump + MAT.
* **Spring:** constructor injection; bean lifecycle; proxies (self-invocation!); auto-config via conditions; profiles; `@ConfigurationProperties`.
* **JPA:** persistence context, dirty checking, LAZY by default, N+1 fixes, `@Version`, no entities in APIs, Flyway not `ddl-auto`.
* **Transactions:** service layer, short, rollback only on unchecked by default, propagation types, no remote calls inside.
* **Security:** BCrypt, JWT validation, short access + rotating refresh tokens, ownership checks, CSRF vs CORS.
* **Microservices:** timeouts + retries (jitter) + circuit breakers, saga + outbox + idempotent consumers, Kafka ordering by key, observability.
* **SQL:** joins, window functions, composite index leftmost prefix, `EXPLAIN`, `NOT EXISTS` over `NOT IN`.
* **System design:** requirements → estimates → API → data → architecture → deep dive → trade-offs.

## 22.2 Rapid-fire (answer each in one or two sentences)

1. Why override `hashCode` with `equals`? *Hash collections locate by hash first.*
2. Can a `HashMap` key be mutable? *Yes technically, but changing fields used in `hashCode` loses the entry.*
3. Why is `String` a bad choice for passwords? *Immutable and lingers in memory; `char[]` can be wiped.*
4. What does `Collections.unmodifiableList` do? *A read-only *view*; changes to the original show through; `List.copyOf` makes an immutable copy.*
5. Difference between `Stream.toList()` and `collect(toList())`? *The first (Java 16+) returns an unmodifiable list.*
6. What is a happens-before relationship? *A guarantee that one action's writes are visible to another (locks, volatile, thread start/join).*
7. When does `ConcurrentModificationException` occur? *Structural modification during fail-fast iteration, not only from multiple threads.*
8. What does `@SpringBootApplication` include? *`@Configuration`, `@EnableAutoConfiguration`, `@ComponentScan`.*
9. Default bean scope? *Singleton (per container).*
10. Why not use field injection? *Hidden dependencies, no immutability, harder tests.*
11. Does `@Transactional` work on private methods? *No — proxy-based.*
12. Does a checked exception roll back by default? *No.*
13. What is the persistence context? *The first-level cache and change tracker of an `EntityManager`.*
14. Difference between flush and commit? *Flush sends SQL; commit makes it permanent.*
15. Why do indexes slow writes? *Each write must update every index.*
16. `RANK` vs `DENSE_RANK`? *RANK leaves gaps after ties.*
17. What makes an API idempotent? *Repeating it has the same effect, e.g., PUT/DELETE or a POST with an idempotency key.*
18. 401 vs 403? *Unauthenticated vs authenticated but forbidden.*
19. What is eventual consistency? *Replicas/services converge after some delay if no new updates.*
20. Why is the outbox pattern needed? *To update the DB and publish an event atomically.*
21. At-least-once vs exactly-once? *Duplicates possible vs processed once; the latter usually needs idempotency.*
22. What is a bounded context? *A boundary where a domain model and language are consistent.*
23. Liveness vs readiness probe? *Restart me vs send me traffic.*
24. What is a canary release? *Roll out to a small share of traffic first and watch metrics.*
25. What does `-XX:MaxRAMPercentage` do? *Sizes the heap as a percentage of container memory.*

## 22.3 Mock interview routine (last two weeks)

1. Pick 5 questions daily from different parts; answer aloud against a timer (90 seconds).
2. Solve 2 coding problems daily without looking, then write the complexity and edge cases.
3. Once a week, do a full 45-minute system design on paper.
4. Review your own project: draw the architecture, list 3 incidents, 3 design decisions, 3 improvements.
5. Prepare questions for the interviewer (team structure, on-call, deployment frequency, tech debt, growth).

## 22.4 Final advice

Senior interviews reward **clarity, trade-offs and honesty**. If you do not know something, say what you *do* know, reason out loud, and explain how you would find out. Verify version-specific claims (Java, Spring Boot, Hibernate) against the official documentation before the interview, since those projects evolve quickly.

**Good luck!**
