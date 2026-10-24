# Part 8 — Spring Core and Spring Boot

## 8.1 What is Spring, IoC and DI?

**Interview question:** *What is Inversion of Control and Dependency Injection? Why does Spring use them?*

**Simple answer:** Normally *your* code creates the objects it needs (`new PaymentService()`). With **IoC**, you hand that control to a container: it creates objects (called **beans**), wires them together and manages their life. **Dependency Injection** is the way the container gives each object its dependencies, usually through the constructor.

**Real-life example:** A restaurant chef does not buy vegetables and build the oven; a manager delivers them. The chef just cooks. In code, `OrderService` just uses a `PaymentGateway`; Spring supplies the concrete one.

```java
@Service
public class OrderService {
    private final PaymentGateway gateway;          // depends on an interface
    private final OrderRepository repo;

    public OrderService(PaymentGateway gateway, OrderRepository repo) { // constructor injection
        this.gateway = gateway;
        this.repo = repo;
    }
}
```

**Why it matters:** loose coupling, easy testing (pass mocks), configuration in one place, cross-cutting features via proxies (transactions, security, caching).

**Constructor vs setter vs field injection:**

| | Constructor | Setter | Field (`@Autowired` on field) |
|---|---|---|---|
| Immutability (`final`) | Yes | No | No |
| Mandatory dependencies obvious | Yes | No | Hidden |
| Easy unit test without Spring | Yes | Possible | Needs reflection |
| Circular dependency detection | Fails fast | Hidden | Hidden |
| Recommendation | **Default** | Optional deps | Avoid |

Since Spring 4.3, a single constructor needs no `@Autowired`.

## 8.2 The container: BeanFactory vs ApplicationContext

`BeanFactory` is the basic container (lazy bean creation). `ApplicationContext` extends it and adds event publishing, internationalization, environment/profile support, annotation processing, AOP integration, and **eager singleton creation at startup** (so misconfiguration fails fast). In practice you always use `ApplicationContext`.

## 8.3 Bean lifecycle (very common)

1. Container reads bean definitions (annotations, `@Bean`, XML).
2. **Instantiate** the bean (constructor).
3. **Populate** dependencies (setter/field injection).
4. Aware callbacks (`BeanNameAware`, `ApplicationContextAware`).
5. `BeanPostProcessor.postProcessBeforeInitialization`.
6. **Initialization:** `@PostConstruct` → `InitializingBean.afterPropertiesSet()` → custom `initMethod`.
7. `BeanPostProcessor.postProcessAfterInitialization` — **this is where AOP proxies are created** (for `@Transactional`, `@Async`, `@Cacheable`).
8. Bean is ready to use.
9. On shutdown: `@PreDestroy` → `DisposableBean.destroy()` → custom `destroyMethod`.

```java
@Component
class CacheWarmer {
    @PostConstruct void warm() { /* runs once after dependencies are injected */ }
    @PreDestroy void flush() { /* cleanup */ }
}
```

**Bean scopes:** `singleton` (default, one per container), `prototype` (new each request; Spring does not manage its destruction), `request`, `session`, `application`, `websocket`.

**Spring singleton vs GoF singleton:** a Spring singleton is one instance **per application context**, not per JVM or per class loader. Singleton beans must be **stateless** (or thread-safe) because many threads share them. Injecting a prototype into a singleton gives you one instance only; use `ObjectProvider<T>` or `@Lookup` to get a fresh one each time.

## 8.4 Stereotype annotations and configuration

* `@Component` — generic. `@Service` — business logic (semantic only). `@Repository` — data access; adds **exception translation** to `DataAccessException`. `@Controller`/`@RestController` — web layer.
* **`@Component` vs `@Bean`:** `@Component` is class-level and auto-detected by scanning; `@Bean` is a method-level factory inside a `@Configuration` class — use it for third-party classes you cannot annotate or when construction logic is non-trivial.
* `@Configuration` classes are CGLIB-proxied so inter-`@Bean` method calls return the same singleton (*full* mode); `@Configuration(proxyBeanMethods = false)` is faster when you do not call bean methods from each other.
* **Component scanning:** `@SpringBootApplication` scans the package of the main class and sub-packages. Beans outside that package are not found (a classic "bean not found" cause).

```java
@Configuration
class HttpConfig {
    @Bean RestClient restClient(RestClient.Builder b) { return b.baseUrl("https://api.partner.com").build(); }
}
```

**`@Qualifier` vs `@Primary`:** with multiple candidates of one type, `@Primary` marks the default; `@Qualifier("name")` at the injection point chooses explicitly (and wins over `@Primary`).

**Circular dependencies:** A needs B and B needs A. Constructor injection fails with `BeanCurrentlyInCreationException`. Spring Boot 2.6+ prohibits circular references by default. Fix the design (extract a third class, use events, or inject via `@Lazy`) rather than enabling `spring.main.allow-circular-references`.

**`@Value` vs `@ConfigurationProperties`:**

```java
@ConfigurationProperties(prefix = "payment")
@Validated
public record PaymentProperties(@NotBlank String baseUrl, @DefaultValue("2s") Duration timeout, int maxRetries) {}
// enable via @ConfigurationPropertiesScan or @EnableConfigurationProperties
```

`@Value("${x}")` is fine for one-off values; `@ConfigurationProperties` is typed, grouped, validated and supports relaxed binding (`max-retries`, `MAX_RETRIES`). Prefer it.

**Conditional beans:** `@Profile("prod")`, `@ConditionalOnProperty`, `@ConditionalOnMissingBean`, `@ConditionalOnClass`. The auto-configuration system is built on these.

**Spring events:**

```java
publisher.publishEvent(new OrderPlacedEvent(order.getId()));
@Component class Mailer {
    @EventListener void on(OrderPlacedEvent e) { ... }
    @TransactionalEventListener(phase = AFTER_COMMIT) void afterCommit(OrderPlacedEvent e) { ... } // only if the TX committed
}
```

## 8.5 AOP and proxies

**AOP (Aspect-Oriented Programming)** separates cross-cutting concerns (logging, security, transactions, metrics) from business code.

* **Aspect:** the module (a class). **Join point:** a point in execution (Spring supports method execution). **Pointcut:** expression that selects join points. **Advice:** the code to run — `@Before`, `@After`, `@AfterReturning`, `@AfterThrowing`, `@Around`.

```java
@Aspect @Component
class TimingAspect {
    @Around("execution(* com.shop.service..*(..))")
    Object time(ProceedingJoinPoint pjp) throws Throwable {
        long t = System.nanoTime();
        try { return pjp.proceed(); }
        finally { log.info("{} took {} ms", pjp.getSignature(), (System.nanoTime() - t) / 1_000_000); }
    }
}
```

**How it works:** Spring wraps the bean in a **proxy**. Callers get the proxy; it runs advice then delegates to the real object.

| | JDK dynamic proxy | CGLIB proxy |
|---|---|---|
| Requires | Target implements an interface | Subclasses the target class |
| Limits | Only interface methods | Cannot proxy `final` classes/methods |
| Default in Boot | No | **Yes** (`spring.aop.proxy-target-class=true`) |

**Famous limitation: self-invocation.** Calling `this.otherMethod()` inside the same bean bypasses the proxy, so `@Transactional`, `@Async`, `@Cacheable` annotations on `otherMethod` do **not** apply. Fix by moving the method to another bean (or inject self; or use AspectJ weaving). Also, annotated methods must be `public` and called from outside.

## 8.6 Common Spring mistakes

* Package structure puts beans outside the scan path.
* Stateful singleton beans (a mutable field shared by requests).
* `@Transactional` on private methods or self-invoked methods.
* Field injection hiding too many dependencies (a sign the class is too big).
* Business logic in controllers.
* Using `new` for a Spring-managed bean (the result has no injection or proxies).
* Overusing `@Autowired` with `required=false` and null checks.

## 8.7 Spring vs Spring Boot

| | Spring Framework | Spring Boot |
|---|---|---|
| Purpose | Core programming and configuration model (IoC, MVC, Data, TX) | Opinionated, fast setup on top of Spring |
| Configuration | You wire a lot yourself | **Auto-configuration**, sensible defaults |
| Server | Deploy a WAR to an external server | **Embedded** Tomcat/Jetty/Undertow, run a JAR |
| Dependencies | Choose compatible versions yourself | **Starters** and a managed BOM |
| Ops | Add your own | **Actuator**, externalized config |

## 8.8 Spring Boot internals

**Interview question:** *Explain auto-configuration. What does `@SpringBootApplication` do?*

**Simple answer:** `@SpringBootApplication` = `@Configuration` + `@EnableAutoConfiguration` + `@ComponentScan`. Auto-configuration looks at what is on the classpath and in your properties, then registers beans for you *only if you have not defined your own*.

**How auto-config works:**

1. `@EnableAutoConfiguration` imports a selector that reads a list of auto-configuration classes from `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` (Boot 2.7+/3.x; older Boot used `spring.factories`).
2. Each class is guarded by conditions: `@ConditionalOnClass(DataSource.class)`, `@ConditionalOnMissingBean`, `@ConditionalOnProperty`.
3. If `spring-boot-starter-data-jpa` and an H2 driver are present and you defined no `DataSource`, Boot creates one with HikariCP.
4. Your own bean wins thanks to `@ConditionalOnMissingBean`.
5. Debug it: run with `--debug` or `debug=true` to print the **conditions evaluation report**; also Actuator's `/actuator/conditions`.

**Starters** are dependency descriptors (`spring-boot-starter-web` pulls Spring MVC, Jackson, Tomcat, validation basics, logging). The Spring Boot BOM/parent manages compatible versions.

### Startup lifecycle: from `main()` to ready

```text
SpringApplication.run(App.class, args)
 1. Create SpringApplication, detect web app type (servlet / reactive / none)
 2. Load ApplicationContextInitializers & listeners (from AutoConfiguration/spring.factories)
 3. Publish ApplicationStartingEvent
 4. Prepare Environment: command-line args, env vars, application.yml, profiles, then ApplicationEnvironmentPreparedEvent
 5. Print banner, create ApplicationContext (AnnotationConfigServletWebServerApplicationContext)
 6. Prepare context, load bean definitions (component scan + auto-configuration), ApplicationContextInitializedEvent
 7. refresh():
      - BeanFactoryPostProcessors (e.g., process @Configuration, property placeholders)
      - Register BeanPostProcessors
      - Create the embedded web server (Tomcat) 
      - Instantiate all non-lazy singleton beans (DI, @PostConstruct, proxies)
      - Finish refresh -> ContextRefreshedEvent; start the web server on its port
 8. ApplicationStartedEvent
 9. Run CommandLineRunner / ApplicationRunner beans
10. ApplicationReadyEvent  (+ readiness state = ACCEPTING_TRAFFIC)
```

**Configuration precedence (high to low, simplified):** command-line args → Java system properties → OS environment variables → `application-{profile}.yml` → `application.yml` → defaults. Keep secrets **out of the repository**: use environment variables, a secret manager (Vault, AWS Secrets Manager, Kubernetes Secrets), or Spring Cloud Config.

**properties vs yml:** YAML is hierarchical and readable (lists, nesting) but whitespace-sensitive; `.properties` is flat. Functionally equivalent.

**Profiles:** `spring.profiles.active=prod`; `application-prod.yml` overrides common values; `@Profile` conditionally registers beans.

**Embedded servers:** Tomcat is the default; Jetty and Undertow are alternatives (exclude Tomcat from the web starter and add the other). Boot 3.2+ also supports virtual threads.

**Actuator:** production endpoints — `/actuator/health` (with liveness/readiness groups for Kubernetes), `/metrics` (Micrometer), `/info`, `/env`, `/loggers` (change log levels live), `/threaddump`, `/heapdump`. **Expose only what you need and secure them.**

```yaml
management:
  endpoints.web.exposure.include: health,info,metrics,prometheus
  endpoint.health.probes.enabled: true
server:
  shutdown: graceful                 # finish in-flight requests
spring.lifecycle.timeout-per-shutdown-phase: 30s
```

**Logging:** SLF4J API with Logback by default. `logging.level.com.shop=DEBUG`. Use parameterized messages (`log.info("order {}", id)`), never log secrets or personal data, add a correlation id via **MDC**, and use JSON logs in production.

### Spring Boot 2 vs 3 (and later)

| | Boot 2.x | Boot 3.x |
|---|---|---|
| Java | 8+ | **17+** |
| Spring Framework | 5 | 6 |
| Namespace | `javax.*` | **`jakarta.*`** |
| Security config | `WebSecurityConfigurerAdapter` | `SecurityFilterChain` bean (adapter removed) |
| Observability | Sleuth | **Micrometer Tracing / Observation** |
| Native images | Experimental | GraalVM native supported |
| Error format | Custom | `ProblemDetail` (RFC 7807) support |
| Open-source support | Ended (check the Spring project's support policy for exact dates) | Current line |

**Migration checklist (2 → 3):** upgrade to the latest 2.7.x first; move to Java 17; replace `javax.` imports with `jakarta.`; remove `WebSecurityConfigurerAdapter`; update Hibernate (6.x changes ID generation defaults and some HQL behaviour), Flyway, Lombok, Mockito; replace Sleuth with Micrometer Tracing; use the `spring-boot-properties-migrator` and OpenRewrite recipes; update third-party starters. **Boot 4:** the Boot 4.x line is built on Spring Framework 7 (modularized auto-configuration, Jakarta EE 11 baseline, Jackson 3 support). Because the details are still evolving, check the official migration guide before quoting specifics in an interview.

### Testing and deployment in one glance
* Tests: see Part 11. 
* Deployment: build an executable "fat" JAR (`mvn package`), use layered JARs for smaller Docker layers, or build an image with `spring-boot:build-image` (Buildpacks). Use graceful shutdown, readiness probes, externalized config and resource limits. See the DevOps part.

---

# Part 9 — Spring MVC and REST APIs

## 9.1 DispatcherServlet and request flow

```text
Client -> Servlet Filters (security, logging, CORS)
       -> DispatcherServlet (front controller)
           1. HandlerMapping: which controller method matches URL + HTTP method?
           2. HandlerAdapter: invoke it
              - HandlerInterceptor.preHandle
              - ArgumentResolvers: @PathVariable, @RequestParam, @RequestBody (HttpMessageConverter / Jackson), @Valid
              - Controller method runs -> calls Service -> Repository
              - Return value handled: @ResponseBody -> HttpMessageConverter -> JSON
           3. Exceptions -> HandlerExceptionResolver -> @ControllerAdvice
       <- Response (interceptor postHandle/afterCompletion, filters on the way out)
```

**`@Controller` vs `@RestController`:** `@RestController` = `@Controller` + `@ResponseBody`: return values are written to the body (JSON) rather than resolved as view names.

**Filter vs Interceptor:** Filters are servlet-level (run before DispatcherServlet; Spring Security lives here). Interceptors are Spring MVC-level and know the handler method.

| Annotation | Reads from | Example |
|---|---|---|
| `@PathVariable` | URL path | `/orders/{id}` identifies a resource |
| `@RequestParam` | Query string / form | `/orders?status=NEW&page=0` filters |
| `@RequestBody` | JSON body (converted by Jackson) | create/update payloads |
| `@ModelAttribute` | Form fields / query params bound to an object | HTML forms, non-JSON |
| `@RequestHeader` | HTTP header | `Idempotency-Key` |

## 9.2 REST design principles

* **Resources are nouns**, plural: `/orders`, `/orders/{id}/items`. Verbs are the HTTP methods.
* **GET** (safe, idempotent) read; **POST** create (not idempotent); **PUT** full replace (idempotent); **PATCH** partial update; **DELETE** (idempotent).
* **Status codes:** 200 OK, 201 Created (+ `Location` header), 204 No Content, 400 bad input, 401 unauthenticated, 403 forbidden, 404 not found, 409 conflict, 422 unprocessable (semantic validation), 429 too many requests, 500 server error, 502/503/504 upstream issues.
* **Stateless:** each request carries what the server needs; scale horizontally.
* **Idempotency** = repeating a request has the same effect as once. Make `POST /payments` safe to retry using an **`Idempotency-Key`** header: store the key + response; if the same key returns, return the stored response.
* **Pagination:** offset (`page`, `size`) is simple but slow/inconsistent for deep pages; **cursor/keyset** (`after=<id>`) is stable and fast for big, changing datasets.
* **Versioning:** URI (`/v1/orders`), header, or media type. Choose one; avoid breaking changes; deprecate with notice.
* **DTOs vs entities:** never expose JPA entities directly. Entities leak internals (and lazy associations and cycles), couple your API to the schema, and invite mass-assignment vulnerabilities. Use DTOs (records) and a mapper (MapStruct).
* **Validation:** `@Valid` (Jakarta Bean Validation, on `@RequestBody`) vs `@Validated` (Spring; supports **validation groups** and works at class level for method parameter validation, e.g., on `@RequestParam` and `@PathVariable`).
* **Content negotiation:** `Accept` header picks the representation (JSON/XML); `Content-Type` describes what you send.
* **CORS:** browser security rule; configure allowed origins explicitly (`CorsConfigurationSource`) — never `*` with credentials.
* **Docs:** springdoc-openapi (`springdoc-openapi-starter-webmvc-ui` for Boot 3) generates OpenAPI + Swagger UI.
* **Rate limiting:** at the API gateway, or per-client token bucket (Bucket4j, Redis); respond 429 + `Retry-After`.
* **Correlation id:** a filter reads or creates `X-Correlation-Id`, puts it in MDC and in the response, and forwards it to downstream calls.
* **File upload:** `MultipartFile`; set `spring.servlet.multipart.max-file-size`; stream large files; validate type/size; store in object storage and return a reference. Download with `ResponseEntity<Resource>` and `Content-Disposition`.

## 9.3 Complete CRUD example (Boot 3, Java 17)

**Entity**

```java
@Entity
@Table(name = "products")
public class Product {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    @Column(nullable = false, length = 120) private String name;
    @Column(nullable = false, precision = 12, scale = 2) private BigDecimal price;
    @Version private Long version;                          // optimistic locking
    protected Product() {}                                  // JPA needs a no-arg constructor
    public Product(String name, BigDecimal price) { this.name = name; this.price = price; }
    // getters/setters omitted
}
```

**DTOs with validation**

```java
public record ProductRequest(
        @NotBlank @Size(max = 120) String name,
        @NotNull @DecimalMin("0.01") BigDecimal price) {}

public record ProductResponse(Long id, String name, BigDecimal price) {}
```

**Mapper (manual; MapStruct generates the same thing)**

```java
@Component
public class ProductMapper {
    public Product toEntity(ProductRequest r) { return new Product(r.name(), r.price()); }
    public ProductResponse toResponse(Product p) { return new ProductResponse(p.getId(), p.getName(), p.getPrice()); }
}
```

**Repository**

```java
public interface ProductRepository extends JpaRepository<Product, Long> {
    Page<Product> findByNameContainingIgnoreCase(String name, Pageable pageable);
}
```

**Service**

```java
@Service
public class ProductService {
    private final ProductRepository repo;
    private final ProductMapper mapper;
    public ProductService(ProductRepository repo, ProductMapper mapper) { this.repo = repo; this.mapper = mapper; }

    @Transactional
    public ProductResponse create(ProductRequest req) { return mapper.toResponse(repo.save(mapper.toEntity(req))); }

    @Transactional(readOnly = true)
    public ProductResponse get(Long id) {
        return repo.findById(id).map(mapper::toResponse)
                   .orElseThrow(() -> new ResourceNotFoundException("Product " + id + " not found"));
    }

    @Transactional(readOnly = true)
    public Page<ProductResponse> search(String name, Pageable p) {
        return repo.findByNameContainingIgnoreCase(name, p).map(mapper::toResponse);
    }

    @Transactional
    public ProductResponse update(Long id, ProductRequest req) {
        Product p = repo.findById(id).orElseThrow(() -> new ResourceNotFoundException("Product " + id + " not found"));
        p.setName(req.name()); p.setPrice(req.price());     // dirty checking writes the UPDATE at commit
        return mapper.toResponse(p);
    }

    @Transactional
    public void delete(Long id) {
        if (!repo.existsById(id)) throw new ResourceNotFoundException("Product " + id + " not found");
        repo.deleteById(id);
    }
}
```

**Controller**

```java
@RestController
@RequestMapping("/api/v1/products")
@Validated
public class ProductController {
    private final ProductService service;
    public ProductController(ProductService service) { this.service = service; }

    @PostMapping
    public ResponseEntity<ProductResponse> create(@Valid @RequestBody ProductRequest req, UriComponentsBuilder uri) {
        ProductResponse created = service.create(req);
        return ResponseEntity.created(uri.path("/api/v1/products/{id}").build(created.id())).body(created);
    }
    @GetMapping("/{id}") public ProductResponse get(@PathVariable Long id) { return service.get(id); }
    @GetMapping public Page<ProductResponse> search(@RequestParam(defaultValue = "") String name,
            @PageableDefault(size = 20, sort = "name") Pageable pageable) { return service.search(name, pageable); }
    @PutMapping("/{id}") public ProductResponse update(@PathVariable Long id, @Valid @RequestBody ProductRequest req) { return service.update(id, req); }
    @DeleteMapping("/{id}") @ResponseStatus(HttpStatus.NO_CONTENT) public void delete(@PathVariable Long id) { service.delete(id); }
}
```

**Explanation of key lines:** `@Valid` triggers Bean Validation and `MethodArgumentNotValidException` (handled in the global handler in Part 5); `ResponseEntity.created` gives status 201 and a `Location` header; `readOnly = true` hints that no writes occur (Hibernate skips dirty checking/flush; some drivers can route to replicas); `update` has no `save()` call because the entity is **managed** and dirty checking persists changes; `@Version` produces a `409` path when two clients update concurrently; pageable parameters are `?page=0&size=20&sort=name,asc`.

## 9.4 Designing reliable APIs: checklist

* Idempotency keys for create/payment operations; timeouts and retries (safe methods only) on clients.
* Consistent error format (Part 5), correlation ids, structured logs, metrics (latency, error rate).
* Backward-compatible evolution: add fields, do not remove or rename; version when needed.
* Input limits (body size, page size caps), validation, and auth on every endpoint.
* **Duplicate request handling:** unique constraint on a business key (e.g., `(user_id, idempotency_key)`) + catch the violation and return the original result.

---

# Part 10 — Spring Data JPA, Hibernate and Transactions

## 10.1 JPA vs Hibernate vs Spring Data JPA

* **JPA (Jakarta Persistence)** — the *specification* (interfaces/annotations: `@Entity`, `EntityManager`, JPQL).
* **Hibernate** — the most popular *implementation* of JPA (it also has extras like `@BatchSize`, `@NaturalId`, filters).
* **Spring Data JPA** — a layer on top that **generates repository implementations** (`JpaRepository`) and derived queries so you write less boilerplate. It still uses Hibernate/`EntityManager` underneath.
* **JDBC vs JPA:** JDBC = low level SQL + manual mapping (maximum control); JPA = object mapping, caching, dirty checking (productivity, but you must understand generated SQL).

## 10.2 Entity lifecycle and the persistence context

| State | Meaning |
|---|---|
| **Transient (new)** | `new Product()`, not known to JPA |
| **Managed (persistent)** | Attached to a persistence context; changes are tracked |
| **Detached** | Was managed; the context closed (or `detach`); changes not tracked |
| **Removed** | Scheduled for deletion at flush |

**Persistence context = first-level cache.** Within one transaction, loading the same id twice returns the **same object** with no second SQL. **Dirty checking:** at flush, Hibernate compares managed entities with their loaded snapshots and issues `UPDATE`s automatically. **Flush** sends SQL to the database (before queries in auto mode, and at commit); **commit** makes it permanent. A flush without commit is rolled back if the transaction fails.

* `save()` — `persist` for new entities, `merge` for existing (checks `isNew` via id or `@Version`). `saveAndFlush()` also flushes immediately (rarely needed).
* `findById()` hits the DB now (returns `Optional`); `getReferenceById()` returns a **lazy proxy** without a query — great for setting a foreign key without loading the whole row, but touching it outside a session may throw `LazyInitializationException`/`EntityNotFoundException`.
* **Second-level cache** is optional (shared across sessions; Ehcache/Caffeine/Redis via providers): good for rarely changed reference data; adds staleness and complexity.

## 10.3 Fetching, LazyInitializationException, N+1

* `FetchType.LAZY` loads an association only when accessed; `EAGER` loads it immediately. Defaults: `@ManyToOne`/`@OneToOne` are **EAGER**; `@OneToMany`/`@ManyToMany` are **LAZY**. Best practice: make everything **LAZY** and fetch what you need per use case.
* **`LazyInitializationException`:** accessing a lazy association after the session/transaction closed (typical in the controller or JSON serialization). Fixes: fetch in the query (`JOIN FETCH`, `@EntityGraph`), map to a DTO **inside** the transaction, or use projections. **Avoid** `spring.jpa.open-in-view=true` as a crutch (it is the Boot default and keeps the connection open during view rendering; consider setting it to `false`).

**N+1 problem:** load N orders (1 query), then access `order.getItems()` for each (N queries) → N+1 queries.

```java
// Problem
List<Order> orders = orderRepo.findAll();                // 1 query
orders.forEach(o -> o.getItems().size());                // +N queries

// Fix 1: fetch join
@Query("select distinct o from Order o join fetch o.items where o.status = :s")
List<Order> findWithItems(@Param("s") OrderStatus s);

// Fix 2: entity graph
@EntityGraph(attributePaths = "items")
List<Order> findByStatus(OrderStatus s);

// Fix 3: batch fetching (config) - loads items for many orders in IN (...) queries
// spring.jpa.properties.hibernate.default_batch_fetch_size=50

// Fix 4: DTO projection - select only needed columns, no entities
@Query("select new com.shop.OrderSummary(o.id, o.status, count(i)) from Order o left join o.items i group by o.id, o.status")
List<OrderSummary> summaries();
```

Cautions: fetch-joining **multiple collections** causes `MultipleBagFetchException`/cartesian products; **pagination with collection fetch join** makes Hibernate paginate in memory (warning `HHH000104`) — fetch ids page first, then fetch details, or use batch size. **Detect N+1:** `spring.jpa.show-sql` (dev only), Hibernate statistics, `datasource-proxy`/p6spy, and tests asserting query counts.

## 10.4 Relationships

```java
@Entity class Order {
    @Id @GeneratedValue Long id;
    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<OrderItem> items = new ArrayList<>();            // inverse side
    public void addItem(OrderItem i) { items.add(i); i.setOrder(this); }   // keep both sides in sync
}
@Entity class OrderItem {
    @Id @GeneratedValue Long id;
    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "order_id")                                // owning side: holds the FK
    private Order order;
}
```

* **Owning side** = the side that has the foreign key (`@JoinColumn`); **`mappedBy`** marks the inverse side. JPA only looks at the **owning side** to write the foreign key.
* **Cascade:** propagate operations (`PERSIST`, `MERGE`, `REMOVE`, `ALL`). **`orphanRemoval`** deletes children removed from the collection. Use cascade only for true parent-owned children (Order → OrderItem), never `REMOVE` across independent aggregates.
* **ManyToMany:** use a join table; for extra columns (quantity, date) model the join as its own entity.
* Prefer `Set` or a `List` with care; `@OneToMany` unidirectional without `@JoinColumn` generates an extra join table and inefficient SQL — use bidirectional or `@JoinColumn`.

**Entity equality:** don't use Lombok `@Data` on entities (it includes associations → recursion / lazy loading). Typical safe approach: `equals` based on the **id when not null** (with `getClass` or Hibernate proxy handling) and a constant `hashCode` (`return getClass().hashCode();`), or use a business key (natural id).

## 10.5 Queries

* **Derived queries:** `findByEmailAndActiveTrue`, `countByStatus`, `existsByEmail`.
* **JPQL** works on entities and is DB-independent; **native SQL** (`nativeQuery = true`) for DB-specific features/performance.
* **Specifications / Criteria API** (`JpaSpecificationExecutor`) for dynamic filters; **Querydsl** is another popular option.
* **Pagination:** `Pageable` + `Page<T>` (issues an extra `count(*)` query) or `Slice<T>` (no count; "has next").
* **Projections:** interface or record-based DTO projections reduce data loaded.
* **Bulk updates:** `@Modifying @Query("update Product p set p.price = p.price * 1.1")` bypasses the persistence context. Managed entities become stale; use `@Modifying(clearAutomatically = true, flushAutomatically = true)`.

```java
@Modifying(clearAutomatically = true, flushAutomatically = true)
@Query("update Order o set o.status = 'EXPIRED' where o.status = 'NEW' and o.createdAt < :cutoff")
int expireOld(@Param("cutoff") Instant cutoff);
```

## 10.6 Locking

* **Optimistic** (`@Version`): no DB lock; on update Hibernate adds `where id=? and version=?`. If 0 rows are updated → `ObjectOptimisticLockingFailureException` → return 409 and let the client retry/reload. Best for mostly-read or low-conflict data.
* **Pessimistic** (`@Lock(PESSIMISTIC_WRITE)` → `SELECT ... FOR UPDATE`): blocks other writers until commit. Use for high-conflict hot rows (inventory, seats), keep the transaction short, always set a timeout (`jakarta.persistence.lock.timeout`), and lock in consistent order to avoid deadlocks.

## 10.7 Other production topics

* **Auditing:** `@EnableJpaAuditing` with `@CreatedDate`, `@LastModifiedDate`, `@CreatedBy` and `AuditingEntityListener`.
* **Migrations:** Flyway (`V1__init.sql`, versioned SQL) or Liquibase (changelogs). **Never** use `ddl-auto=update` in production; use `validate` or `none`. Make migrations backwards-compatible (expand → migrate → contract) so rolling deployments work.
* **HikariCP:** `maximumPoolSize` (don't set it huge — the database is the limit; more connections ≠ more throughput), `connectionTimeout`, `maxLifetime` (shorter than DB/firewall timeout), `leakDetectionThreshold`. Pool exhaustion shows up as `Connection is not available, request timed out`, usually caused by long transactions, slow queries, or leaked connections.
* **Performance tuning:** fix N+1; use projections; `hibernate.jdbc.batch_size` with `order_inserts/order_updates` for batch writes (note: `IDENTITY` ids disable JDBC insert batching — use `SEQUENCE`); add indexes; avoid loading huge result sets (stream or page); limit `EAGER`; consider the read model (CQRS) for heavy reporting.
* **Common production issues:** open-in-view holding connections, LazyInitializationException, N+1, missing indexes, long transactions with remote calls inside, `equals/hashCode` bugs in sets, `ddl-auto` surprises, enum stored as ordinal (use `@Enumerated(STRING)`).

## 10.8 `@Transactional` in depth

**How it works:** Spring creates a **proxy** around the bean. When an outside caller invokes a `@Transactional` method, the proxy's `TransactionInterceptor` gets a connection from the pool, sets auto-commit to false, binds the transaction to the **current thread** (`ThreadLocal`), runs your method, then **commits** on normal return or **rolls back** on exception, and releases the connection.

**Rollback rule (very common trap):** by default rollback happens for **unchecked** exceptions (`RuntimeException`, `Error`). **Checked exceptions commit** unless you say `@Transactional(rollbackFor = Exception.class)`.

**Why "@Transactional is not working":**
1. **Self-invocation** (method called through `this`). 2. Method is `private`/`final`/not `public` (proxy limitations). 3. Bean not Spring-managed (`new`). 4. Checked exception thrown without `rollbackFor`. 5. Exception caught and swallowed inside the method. 6. Wrong import (`javax.transaction.Transactional` also works, but know which you used) or using it on an interface with a CGLIB/JDK mismatch. 7. A different `@Transactional` propagation (e.g., `REQUIRES_NEW` committed independently). 8. Work performed on another thread (`@Async`, parallel streams, `CompletableFuture`) — the transaction is thread-bound, so the other thread is **not** in it. 9. Non-transactional storage (some NoSQL).

**Propagation**

| Propagation | Behaviour |
|---|---|
| `REQUIRED` (default) | Join the current TX; otherwise create one |
| `REQUIRES_NEW` | Suspend the current TX; run in a brand-new, independent TX |
| `SUPPORTS` | Join if exists, else run non-transactionally |
| `NOT_SUPPORTED` | Suspend any TX; run non-transactionally |
| `MANDATORY` | Must already be in a TX, otherwise exception |
| `NEVER` | Must **not** be in a TX, otherwise exception |
| `NESTED` | Savepoint inside the current TX (needs JDBC savepoints; JPA/Hibernate dialect support limited) |

**Real example (audit that survives rollback):**

```java
@Service class OrderService {
    private final AuditService audit;
    @Transactional
    public void placeOrder(OrderRequest r) {
        audit.record("ORDER_ATTEMPT", r);     // REQUIRES_NEW: saved even if the order fails
        ... // may throw -> order rolled back, audit remains
    }
}
@Service class AuditService {
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void record(String type, Object payload) { ... }
}
```

(`audit` is a *different bean* — the proxy applies. Putting `record()` in the same class would break this.) Note: `REQUIRES_NEW` holds **two connections** at once; under a small pool this can **deadlock the pool itself**.

**Isolation levels and anomalies**

| Level | Dirty read | Non-repeatable read | Phantom read |
|---|---|---|---|
| READ_UNCOMMITTED | possible | possible | possible |
| READ_COMMITTED | prevented | possible | possible |
| REPEATABLE_READ | prevented | prevented | possible in the standard (MySQL InnoDB largely prevents with gap locks; PostgreSQL's snapshot isolation prevents it) |
| SERIALIZABLE | prevented | prevented | prevented |

* *Dirty read:* see another transaction's uncommitted data. *Non-repeatable read:* the same row read twice gives different values. *Phantom:* the same query returns new rows. Defaults: PostgreSQL/Oracle/SQL Server → READ_COMMITTED; MySQL InnoDB → REPEATABLE_READ. Behaviour varies by database — verify for yours.

**Other options:** `readOnly=true`, `timeout=5` (seconds), `rollbackFor / noRollbackFor`. **Boundaries:** put `@Transactional` on the **service layer** (a use case = one transaction), not on controllers or individual repository calls. Keep transactions **short**: never call slow external HTTP services inside a transaction (holds a DB connection and locks).

**Database vs distributed transactions:** a local ACID transaction works for one database. Across services you cannot use one transaction; use **Saga/outbox** with eventual consistency (Part 12). 2PC/XA exists (JTA) but is rarely used in microservices because of coupling, blocking and availability issues.

**How to debug an unexpected commit:** enable `logging.level.org.springframework.transaction.interceptor=TRACE` and `org.springframework.orm.jpa=DEBUG`; check the exception type (checked?); check if the exception was caught; check propagation (an inner `REQUIRES_NEW` already committed); check proxies (is the call going through the proxy?); print `TransactionSynchronizationManager.isActualTransactionActive()`.

**Interview-ready answer:** "@Transactional works through a proxy that opens a transaction before the method and commits or rolls back after. Default rollback is only for unchecked exceptions. It breaks on self-invocation, non-public methods, swallowed exceptions or thread switches. I keep transactions on the service layer, short, with no remote calls inside, and use REQUIRES_NEW sparingly for things like audit logs."
