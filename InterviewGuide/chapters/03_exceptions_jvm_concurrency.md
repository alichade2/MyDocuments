# Part 5 — Exception Handling

## 5.1 Checked vs unchecked

**Simple answer:** *Checked* exceptions (subclasses of `Exception` but not `RuntimeException`) must be caught or declared; the compiler forces it. *Unchecked* exceptions (`RuntimeException` and `Error`) need not be. `Error` signals JVM-level problems (`OutOfMemoryError`) and should not normally be caught.

```text
Throwable
 ├── Error (OutOfMemoryError, StackOverflowError)         - do not catch
 └── Exception
      ├── IOException, SQLException ... (checked)
      └── RuntimeException (unchecked): NullPointerException, IllegalArgumentException, IllegalStateException
```

**Guideline:** use checked exceptions when the caller can reasonably recover (rare in modern code). Use unchecked exceptions for programming errors and business rule violations in most Spring apps. Spring wraps `SQLException` into unchecked `DataAccessException`.

`throw` raises one exception; `throws` declares what a method may raise.

## 5.2 try-catch-finally and try-with-resources

```java
try (BufferedReader br = Files.newBufferedReader(path);
     Connection c = ds.getConnection()) {     // closed automatically in reverse order
    ...
} catch (IOException | SQLException e) {      // multi-catch
    throw new ReportException("Could not build report", e); // keep the cause
}
```

Resources must implement `AutoCloseable`. If both the body and `close()` throw, the body's exception is primary and the close exception is **suppressed** (`getSuppressed()`).

## 5.3 Best practices

* Never swallow exceptions (`catch (Exception e) {}`). At minimum log with the stack trace **once**, at the boundary that handles it. Do not log and rethrow at every layer (duplicate noise).
* Wrap with context and keep the cause: `new OrderException("Order " + id + " failed", e)`.
* Catch the most specific type. Do not catch `Throwable`.
* Do not use exceptions for normal control flow (slow stack-trace creation, hard to read).
* Do not leak internals (SQL, stack traces) to API clients.
* Create custom exceptions with meaning: `InsufficientBalanceException`, `ResourceNotFoundException`.

## 5.4 Global exception handling in Spring Boot

```java
public record ApiError(Instant timestamp, int status, String code, String message, String path,
                       List<String> details) {}

@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(ResourceNotFoundException.class)
    public ResponseEntity<ApiError> notFound(ResourceNotFoundException ex, HttpServletRequest req) {
        return build(HttpStatus.NOT_FOUND, "NOT_FOUND", ex.getMessage(), req, List.of());
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiError> validation(MethodArgumentNotValidException ex, HttpServletRequest req) {
        List<String> details = ex.getBindingResult().getFieldErrors().stream()
                .map(f -> f.getField() + ": " + f.getDefaultMessage()).toList();
        return build(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Invalid request", req, details);
    }

    @ExceptionHandler(ObjectOptimisticLockingFailureException.class)
    public ResponseEntity<ApiError> conflict(Exception ex, HttpServletRequest req) {
        return build(HttpStatus.CONFLICT, "CONCURRENT_UPDATE", "Resource was modified, retry", req, List.of());
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiError> fallback(Exception ex, HttpServletRequest req) {
        log.error("Unhandled error on {}", req.getRequestURI(), ex);           // full detail in logs
        return build(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "Something went wrong", req, List.of());
    }

    private ResponseEntity<ApiError> build(HttpStatus s, String code, String msg, HttpServletRequest r, List<String> d) {
        return ResponseEntity.status(s).body(new ApiError(Instant.now(), s.value(), code, msg, r.getRequestURI(), d));
    }
    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);
}
```

*(Uses Java 16+ `record` and `Stream.toList()`; replace with a class and `Collectors.toList()` on Java 8.)* Spring 6 / Boot 3 also supports RFC 7807 `ProblemDetail`.

---

# Part 6 — JVM, Memory and Garbage Collection

## 6.1 JVM architecture and memory areas

```text
                 +------------------- JVM -------------------+
 .class files -> | Class Loader Subsystem                     |
                 | Runtime Data Areas:                        |
                 |   Heap (shared)    : Young (Eden,S0,S1) + Old |
                 |   Metaspace (shared, native memory): class metadata |
                 |   Per thread: JVM Stack, PC register, Native stack  |
                 | Execution Engine: Interpreter, JIT, GC     |
                 +--------------------------------------------+
```

| Area | Stores | Notes |
|---|---|---|
| **Heap** | All objects, arrays | Shared; GC-managed; `-Xms`, `-Xmx` |
| **Stack** (per thread) | Frames: local variables, operand stack, return address | Fast; `StackOverflowError` if too deep; `-Xss` |
| **Metaspace** | Class metadata, method info | Native memory (Java 8+, replaced PermGen); grows unless capped by `-XX:MaxMetaspaceSize` |
| **PC register** | Current instruction per thread | |
| **String pool, static fields** | On heap | |

**Class loaders:** Bootstrap (core JDK) → Platform (Ext) → Application (your classpath), using **parent delegation**: ask the parent first. This prevents you from replacing `java.lang.String`. Application servers use custom loaders for isolation, which is why classloader leaks happen on redeploy.

**Object creation:** `new Order()` → class loaded? → allocate in Eden (thread-local allocation buffers make this very fast) → zero fields → run constructor.

## 6.2 Garbage collection fundamentals

An object is garbage when it is **unreachable** from **GC roots** (thread stacks, static fields, JNI references).

**Generational hypothesis:** most objects die young. So:

1. New objects go to **Eden**. When Eden is full, a **minor GC** copies survivors into a Survivor space (S0/S1) and increments their age.
2. After surviving enough cycles, objects are **promoted** to the **Old generation**.
3. When the old gen fills up, a **major/mixed/full GC** runs.

**Stop-the-world (STW):** pauses application threads. Collector choice is largely a trade-off between **throughput** and **pause time**.

| Collector | Idea | Typical use |
|---|---|---|
| Serial | Single thread | Tiny apps |
| Parallel | Multi-thread, throughput-focused | Batch jobs |
| **G1** (default since Java 9) | Heap split into regions, collects the most garbage-filled first, targets pause goal (`-XX:MaxGCPauseMillis`) | General servers |
| **ZGC** | Concurrent, very short pauses; generational mode added in Java 21 | Large heaps, low latency |
| Shenandoah | Concurrent compaction (in some OpenJDK builds) | Low latency |

I am not quoting numeric pause times because they depend on workload and hardware. Always measure with GC logs.

## 6.3 Reference types

| Type | Collected when | Use |
|---|---|---|
| Strong | Never while reachable | Normal references |
| `SoftReference` | Memory is low | Memory-sensitive caches |
| `WeakReference` | Next GC if only weakly reachable | `WeakHashMap`, canonical maps |
| `PhantomReference` | After finalization-ready; used with `ReferenceQueue` | Cleanup actions (like `Cleaner`) |

## 6.4 Memory leaks in Java

Java has GC, but leaks happen when objects stay **reachable but unused**:

* Static collections that only grow (`static Map` as cache without eviction)
* Listeners/callbacks never deregistered
* `ThreadLocal` values never removed in thread pools (call `remove()`)
* Unclosed resources (connections, streams)
* Inner classes holding outer references
* Caches without size/TTL (use Caffeine with limits)
* Classloader leaks on redeploys
* Huge `HttpSession` data

**OOM vs SOE:** `OutOfMemoryError` — heap/metaspace/native/threads exhausted (different message: `Java heap space`, `Metaspace`, `unable to create native thread`, `GC overhead limit exceeded`). `StackOverflowError` — recursion too deep (missing base case, cyclic `toString`).

## 6.5 Investigating memory problems

```bash
# Run with: -Xmx2g -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/dumps -Xlog:gc*:file=gc.log
jcmd <pid> GC.heap_info
jcmd <pid> GC.class_histogram | head -30     # which classes use the most instances
jcmd <pid> GC.heap_dump /tmp/heap.hprof      # analyse in Eclipse MAT or VisualVM
jcmd <pid> Thread.print > threads.txt        # or jstack <pid>
```

**Method:**
1. Is it a leak (old gen grows after every full GC) or just too small a heap (stable high usage)?
2. Take a heap dump; open in **Eclipse MAT** → "Leak suspects" and the **dominator tree** to see who retains the memory.
3. Look at **GC logs**: frequency, pause times, heap after GC.
4. Compare two dumps over time. Find the GC-root path ("path to GC roots").
5. Fix: bound the cache, remove listeners, close resources, paginate queries instead of loading entire tables.

**Tuning:** do not tune blindly. Set `-Xms=-Xmx` for servers, choose a collector for your latency goals, size containers properly (JVM is container-aware since Java 10; use `-XX:MaxRAMPercentage`), and fix allocation hot spots first.

---

# Part 7 — Multithreading and Concurrency

## 7.1 Basics

* **Process:** independent program with its own memory. **Thread:** lightweight execution path *inside* a process, sharing heap memory (hence the concurrency problems).
* **Thread states:** `NEW → RUNNABLE ⇄ BLOCKED / WAITING / TIMED_WAITING → TERMINATED`.
* **Creating work:** extend `Thread` (avoid), implement `Runnable` (no result, no checked exception), implement `Callable<V>` (returns a value, may throw), or submit to an `ExecutorService`.

```java
ExecutorService pool = Executors.newFixedThreadPool(4);
Future<Integer> f = pool.submit(() -> expensiveCalculation());
int result = f.get(2, TimeUnit.SECONDS);       // blocks; use a timeout
pool.shutdown();
```

## 7.2 Race condition, synchronized and visibility

**Question:** *Why is `count++` not thread-safe?*

**Simple answer:** `count++` is three steps — read, add, write. Two threads can read the same value and both write back `old+1`, losing an update. That is a **race condition**.

```java
class Counter {
    private int count;
    public synchronized void inc() { count++; }          // atomicity + visibility
    public synchronized int get() { return count; }
}
```

`synchronized` gives two guarantees: **mutual exclusion** (one thread at a time per monitor) and **visibility** (changes before releasing a lock are seen by the next thread acquiring it — the *happens-before* relationship).

* On an instance method, the lock is `this`; on a static method, the `Class` object; on a block, any object you choose. Prefer a private lock object: `private final Object lock = new Object();`.
* Locks are **reentrant**: a thread can re-enter locks it already holds.
* Internally, every Java object has a monitor; the JVM optimizes uncontended locking (biased/lightweight locks have evolved across versions; do not quote specifics).

**`volatile` vs `synchronized`:**

| | volatile | synchronized |
|---|---|---|
| Visibility | Yes | Yes |
| Atomicity of compound actions | **No** | Yes |
| Blocking | No | Yes |
| Use | Flags (`running`), safe publication of immutable object | Critical sections |

```java
private volatile boolean running = true;   // visible to the worker thread immediately
```

## 7.3 Atomic classes and CAS

`AtomicInteger`, `AtomicLong`, `AtomicReference` use **Compare-And-Swap** — a CPU instruction: "set to new only if the current value equals what I last read; otherwise retry." This is lock-free and fast under moderate contention. For heavily contended counters, `LongAdder` is better. CAS has the **ABA problem** (value changed A→B→A; solved with `AtomicStampedReference`).

```java
AtomicInteger hits = new AtomicInteger();
hits.incrementAndGet();
```

## 7.4 ReentrantLock and ReadWriteLock

```java
private final ReentrantLock lock = new ReentrantLock();
public boolean tryTransfer(...) throws InterruptedException {
    if (!lock.tryLock(1, TimeUnit.SECONDS)) return false;   // can time out, unlike synchronized
    try { ...; return true; }
    finally { lock.unlock(); }                               // ALWAYS in finally
}
```

`ReentrantLock` adds `tryLock`, timed/interruptible locking, fairness, and multiple `Condition`s. `ReadWriteLock` lets many readers or one writer — useful for read-heavy shared data. `StampedLock` supports optimistic reads.

## 7.5 wait / notify

Used inside `synchronized` for thread coordination (the building block for producer-consumer). Always call `wait()` in a **loop** (spurious wakeups) and prefer `BlockingQueue` or `CountDownLatch` in new code.

```java
synchronized (lock) { while (!ready) lock.wait(); ... }
synchronized (lock) { ready = true; lock.notifyAll(); }
```

## 7.6 Deadlock, starvation, livelock

* **Deadlock:** A holds lock 1 and waits for lock 2; B holds lock 2 and waits for lock 1. Four conditions: mutual exclusion, hold-and-wait, no preemption, circular wait.
* **Prevention:** acquire locks in a **consistent global order**; use `tryLock` with timeout; keep critical sections small; avoid calling foreign code while holding a lock.
* **Starvation:** a thread never gets CPU or lock. **Livelock:** threads keep reacting to each other without progress.
* **Detect:** `jstack <pid>` prints "Found one Java-level deadlock"; `ThreadMXBean.findDeadlockedThreads()`.

```java
void transfer(Account a, Account b, long amt) {
    Account first = a.id < b.id ? a : b, second = a.id < b.id ? b : a;   // consistent order
    synchronized (first) { synchronized (second) { a.debit(amt); b.credit(amt); } }
}
```

## 7.7 Thread pools

| Factory | Behaviour | Caution |
|---|---|---|
| `newFixedThreadPool(n)` | n threads, **unbounded** queue | Queue can grow until OOM |
| `newCachedThreadPool()` | Creates threads on demand | Unbounded threads → can crash under load |
| `newScheduledThreadPool(n)` | Delayed/periodic tasks | |
| `newSingleThreadExecutor()` | One worker, ordered | |
| `newVirtualThreadPerTaskExecutor()` | Java 21 virtual threads | See below |

In production, build **bounded** pools explicitly:

```java
ThreadPoolExecutor ex = new ThreadPoolExecutor(
    8, 16, 60, TimeUnit.SECONDS,
    new ArrayBlockingQueue<>(200),                    // bounded queue
    new ThreadFactoryBuilder().setNameFormat("order-%d").build(), // name threads (Guava) or custom factory
    new ThreadPoolExecutor.CallerRunsPolicy());       // back-pressure instead of failure
```

Order of events: core threads first → then queue → then extra threads up to max → then the rejection policy. Pool sizing: CPU-bound ≈ number of cores; I/O-bound can be higher; measure.

## 7.8 BlockingQueue and producer–consumer

```java
BlockingQueue<Order> queue = new ArrayBlockingQueue<>(100);
// producer
queue.put(order);                 // blocks if full (back-pressure)
// consumer
Order o = queue.take();           // blocks if empty
```

Other tools: `CountDownLatch` (wait for N events), `CyclicBarrier`, `Semaphore` (limit concurrent access), `Phaser`, `Exchanger`.

## 7.9 ForkJoinPool

Divide-and-conquer pool where idle workers **steal** tasks from busy workers' queues. Used by parallel streams and `CompletableFuture` async methods by default (the common pool). Use `RecursiveTask<V>` and `fork()/join()`.

## 7.10 CompletableFuture

```java
CompletableFuture<Order> orderF = CompletableFuture.supplyAsync(() -> orderClient.get(id), ioPool);
CompletableFuture<User> userF   = CompletableFuture.supplyAsync(() -> userClient.get(uid), ioPool);

CompletableFuture<Summary> summary = orderF.thenCombine(userF, Summary::new)   // combine independent results
        .orTimeout(2, TimeUnit.SECONDS)                                         // Java 9+
        .exceptionally(ex -> Summary.fallback())                               // recover
        .whenComplete((r, ex) -> log.info("done"));
CompletableFuture.allOf(orderF, userF).join();                                  // wait for all
```

| | Future | CompletableFuture |
|---|---|---|
| Get result | Blocking `get()` | Callbacks + chaining |
| Compose | No | `thenApply`, `thenCompose`, `thenCombine` |
| Exceptions | Wrapped in `ExecutionException` | `exceptionally`, `handle` |
| Manual completion | No | `complete()` |

`thenApply` = map; `thenCompose` = flatMap (when the next step returns a CompletableFuture). **Always pass your own executor** for blocking work; do not block the common pool.

## 7.11 Virtual threads (Java 21)

Virtual threads are cheap threads scheduled by the JVM onto a small pool of carrier OS threads. When code blocks on I/O, the virtual thread is unmounted so the carrier is free. **They help** for high-concurrency, blocking I/O workloads (many HTTP/DB calls), letting you keep the simple thread-per-request model. **They do not help** CPU-bound work and are not faster for a single task. Cautions: do not pool them (create one per task), watch for **pinning** (blocking inside `synchronized` pinned the carrier in Java 21; prefer `ReentrantLock`), `ThreadLocal` abuse, and limit downstream resources (a connection pool still caps DB concurrency). Spring Boot 3.2+: `spring.threads.virtual.enabled=true`.

## 7.12 Thread-safety strategies, ordered by preference

1. **Immutability** (final fields, records) — no sharing problem.
2. **Confinement** — keep data in one thread (`ThreadLocal`, local variables).
3. **Concurrent collections / atomics.**
4. **Locks** — last resort, smallest scope.

## 7.13 Classic concurrency coding problems

```java
// Thread-safe lazy singleton (double-checked locking needs volatile)
public class Config {
    private static volatile Config instance;
    private Config() {}
    public static Config get() {
        if (instance == null) { synchronized (Config.class) { if (instance == null) instance = new Config(); } }
        return instance;
    }
}
// Simpler: enum singleton, or the holder idiom
class Holder { private static class H { static final Holder I = new Holder(); } static Holder get() { return H.I; } }

// Print odd/even alternately with two threads: use a shared lock + turn flag, or two Semaphores.
// Producer/consumer: BlockingQueue (shown above).
// Bank transfer without deadlock: ordered locking (shown above).
```

## 7.14 Debugging thread problems in production

* **High CPU:** `top -H -p <pid>` → convert the hot thread id to hex → find in `jstack` output (`nid=0x...`). Take several dumps a few seconds apart.
* **Hung requests:** many threads `WAITING` on the same lock or connection pool → thread dump shows who holds the lock.
* **Thread-pool exhaustion:** all workers busy, queue full, rejections. Find blocking calls without timeouts.
* **Prevent:** timeouts everywhere, bounded pools, bulkheads per dependency, metrics on pool usage (`executor.active`, queue size).
