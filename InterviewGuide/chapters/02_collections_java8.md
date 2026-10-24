# Part 3 — Collections Framework

## 3.1 The big picture

**Collection** (singular) is the root interface for `List`, `Set`, `Queue`. **Collections** (plural) is a utility class with static helpers (`sort`, `unmodifiableList`, `synchronizedList`). **Map** is *not* a `Collection` but is part of the framework.

| Type | Order | Duplicates | Typical use |
|---|---|---|---|
| `List` | Insertion order, indexed | Yes | Ordered results, lookups by position |
| `Set` | Depends on implementation | No | Uniqueness checks |
| `Queue/Deque` | FIFO / both ends | Yes | Task queues, BFS, sliding windows |
| `Map` | Depends on implementation | Unique keys | Lookups by key, caches, counting |

## 3.2 ArrayList vs LinkedList

**Simple answer:** `ArrayList` is backed by a dynamic array: fast random access, slow insert/remove in the middle. `LinkedList` is a doubly linked list: fast add/remove at the ends *once you have the node*, slow `get(i)`.

| Operation | ArrayList | LinkedList |
|---|---|---|
| `get(i)` | O(1) | O(n) |
| `add(e)` at end | O(1) amortized | O(1) |
| `add(i, e)` / `remove(i)` middle | O(n) (shifts elements) | O(n) to find, O(1) to link |
| Memory | Compact | Extra object + 2 pointers per element |
| Cache locality | Excellent | Poor |

**Reality check:** in practice `ArrayList` wins in almost every case, even for many inserts, because of memory locality. Use `ArrayDeque` for queues/stacks instead of `LinkedList`.

**Internals:** `ArrayList` starts with capacity 10 (lazily allocated), grows by about 1.5x (`newCap = old + old>>1`) by copying to a new array. If you know the size, pass it to the constructor.

## 3.3 HashSet, LinkedHashSet, TreeSet

| | HashSet | LinkedHashSet | TreeSet |
|---|---|---|---|
| Order | None | Insertion | Sorted (natural or Comparator) |
| add/contains | O(1) average | O(1) average | O(log n) |
| Backed by | HashMap | LinkedHashMap | TreeMap (red-black tree) |
| null | One null | One null | No null (with natural ordering) |

`HashSet` is just a `HashMap` whose values are a dummy constant.

## 3.4 HashMap internal working (most asked)

**Interview question:** *How does HashMap work internally?*

**Simple answer:** HashMap stores entries in an array of **buckets**. For a key it computes `hashCode()`, spreads the bits, takes `index = (n-1) & hash`, and puts the entry in that bucket. Collisions (several keys in one bucket) are chained in a linked list, and since Java 8 a long chain (8+ nodes when table size ≥ 64) becomes a **red-black tree**. When the map exceeds `capacity × loadFactor` (default 16 × 0.75), the table doubles and entries are redistributed.

**Understand it step by step, `put("Asha", 1)`:**

1. `h = key.hashCode()`; then `hash = h ^ (h >>> 16)` mixes high bits into low bits so poor hash functions spread better.
2. `index = (table.length - 1) & hash`. This works as modulo because the length is always a **power of two**.
3. If the bucket is empty, create a node there.
4. If not empty, compare each node: same hash **and** (`==` or `equals()`) key → replace the value. Otherwise append.
5. If the chain length reaches 8 (and table ≥ 64), "treeify". If table < 64, it resizes instead.
6. If `size > threshold`, **resize**: new array is twice as large. Each node goes either to the same index or to `index + oldCapacity`, which makes rehashing cheap.

```text
table (size 16)
[0] -> null
[1] -> (Asha,1) -> (Ravi,2)        <- collision, linked list (or tree if long)
[2] -> null
...
```

**`get(key)`:** same hash → bucket → walk or tree-search using `equals()`. O(1) average, O(log n) worst in Java 8+ (was O(n) in Java 7).

**Java 7 vs Java 8:**

| | Java 7 | Java 8+ |
|---|---|---|
| Collision structure | Linked list only | Linked list → red-black tree |
| Worst-case lookup | O(n) | O(log n) (keys must be Comparable to order well, otherwise tie-broken) |
| Insert in bucket | Head insertion | Tail insertion |
| Resize in concurrent use | Could create infinite loop (circular list) | Fixed that specific issue, but HashMap is **still not thread-safe** |
| Hash function | More complex | `h ^ (h >>> 16)` |

**Null:** HashMap allows one null key (hash 0) and null values. `Hashtable` and `ConcurrentHashMap` allow neither.

**Common mistakes:**
* Using mutable objects as keys. If a field in `hashCode` changes after insertion, the entry can never be found again.
* Forgetting to override `equals` + `hashCode` for custom keys.
* Not pre-sizing a map with a known number of entries (causes repeated resizes).
* Sharing a `HashMap` across threads.

**Follow-ups:** Why is capacity a power of 2? What is the load factor trade-off? What happens when two keys have equal hash but are not equal? Why treeify threshold 8?

**Interview-ready answer:** "A HashMap is an array of buckets. I hash the key, spread the bits, and use `(n-1) & hash` for the index. Collisions are chained; in Java 8 long chains become red-black trees so the worst case is O(log n). When size passes 75% of capacity the table doubles. It relies on equals and hashCode of keys and it is not thread-safe, so for concurrent use I choose ConcurrentHashMap."

## 3.5 HashMap vs Hashtable vs ConcurrentHashMap vs TreeMap

| | HashMap | Hashtable | ConcurrentHashMap | TreeMap |
|---|---|---|---|---|
| Thread-safe | No | Yes (whole-map lock) | Yes (fine-grained) | No |
| Null key/value | Yes | No | No | Values yes; key no (natural order) |
| Ordering | None | None | None | Sorted |
| get/put | O(1) avg | O(1) avg, slow lock | O(1) avg, high concurrency | O(log n) |
| Status | Default | Legacy, avoid | Use for shared maps | Sorted/range queries |

**ConcurrentHashMap internals (high level):** Java 7 used segment locks. Java 8+ uses a table of nodes, **CAS** to insert into empty buckets, and `synchronized` on the **first node of a bucket** for collisions. Reads are mostly lock-free. Iterators are **weakly consistent** (never throw `ConcurrentModificationException`).

**Important:** `ConcurrentHashMap` makes *individual* operations atomic. A check-then-act sequence is still a race:

```java
// Race: two threads both see "absent"
if (!map.containsKey(k)) map.put(k, v);
// Correct, atomic:
map.putIfAbsent(k, v);
map.computeIfAbsent(k, key -> load(key));
map.merge(word, 1, Integer::sum); // atomic counter
```

## 3.6 Comparable vs Comparator

| | Comparable | Comparator |
|---|---|---|
| Package | `java.lang` | `java.util` |
| Method | `compareTo(T o)` | `compare(T a, T b)` |
| Defines | The class's *natural* order | Any *external* order |
| Where | Inside the class | Separate class, lambda |

```java
class Employee {
    String name; double salary; String dept;
    // constructor omitted
}
List<Employee> list = ...;
list.sort(Comparator.comparing((Employee e) -> e.dept)
        .thenComparing(e -> e.salary, Comparator.reverseOrder())
        .thenComparing(e -> e.name));
```

**Trap:** `(a, b) -> a.x - b.x` overflows for large ints. Use `Integer.compare(a.x, b.x)`.

## 3.7 Iterators, fail-fast and ConcurrentModificationException

* **Iterator** goes forward and can `remove()`. **ListIterator** goes both ways and can `add`/`set`.
* **Fail-fast** iterators (ArrayList, HashMap) check an internal `modCount`; if the collection is structurally changed during iteration by something other than the iterator, they throw `ConcurrentModificationException` on a best-effort basis. It is a bug detector, not a guarantee.
* "Fail-safe" is informal terminology. The accurate terms are **weakly consistent** (ConcurrentHashMap) or **snapshot** iterators (`CopyOnWriteArrayList`).

```java
// WRONG
for (String s : names) if (s.startsWith("A")) names.remove(s); // CME

// RIGHT (Java 8+)
names.removeIf(s -> s.startsWith("A"));
// or with iterator
Iterator<String> it = names.iterator();
while (it.hasNext()) if (it.next().startsWith("A")) it.remove();
```

`CopyOnWriteArrayList` copies the array on every write: great when reads vastly outnumber writes (listeners), terrible for frequent writes.

## 3.8 PriorityQueue, Queue, Deque

* `PriorityQueue` is a **binary min-heap** (smallest by default). `offer/poll` O(log n), `peek` O(1). Iteration order is *not* sorted.
* `ArrayDeque` is the best general-purpose stack and queue. `Stack` and `Vector` are legacy.
* `BlockingQueue` (see concurrency) for producer-consumer.

```java
PriorityQueue<Integer> maxHeap = new PriorityQueue<>(Comparator.reverseOrder());
```

## 3.9 Choosing the right collection

| Need | Choose |
|---|---|
| Fast lookup by key | `HashMap` |
| Keep insertion order | `LinkedHashMap` / `LinkedHashSet` |
| Sorted keys / range query | `TreeMap` / `TreeSet` |
| LRU cache | `LinkedHashMap` with `accessOrder=true` + `removeEldestEntry` |
| Shared across threads | `ConcurrentHashMap` |
| Queue / stack | `ArrayDeque` |
| Top-K | `PriorityQueue` |
| Immutable small list | `List.of(...)` (Java 9+) |
| Enum keys | `EnumMap` |

## 3.10 Collections coding problems

```java
// 1. Find duplicates (Java 8)
public static Set<Integer> findDuplicates(List<Integer> nums) {
    Set<Integer> seen = new HashSet<>(), dup = new LinkedHashSet<>();
    for (int n : nums) if (!seen.add(n)) dup.add(n);   // add returns false if already present
    return dup;
}

// 2. Frequency count
Map<String, Long> freq = words.stream()
        .collect(Collectors.groupingBy(Function.identity(), Collectors.counting()));

// 3. Group employees by department
Map<String, List<Employee>> byDept = employees.stream()
        .collect(Collectors.groupingBy(e -> e.dept));

// 4. Sort map by value descending
List<Map.Entry<String, Long>> sorted = new ArrayList<>(freq.entrySet());
sorted.sort(Map.Entry.<String, Long>comparingByValue().reversed());

// 5. First non-repeated character
public static Character firstUnique(String s) {
    Map<Character, Integer> m = new LinkedHashMap<>();
    for (char c : s.toCharArray()) m.merge(c, 1, Integer::sum);
    for (Map.Entry<Character, Integer> e : m.entrySet()) if (e.getValue() == 1) return e.getKey();
    return null;
}
```

---

# Part 4 — Java 8 and Functional Programming

## 4.1 Lambdas and functional interfaces

A **functional interface** has exactly one abstract method (optionally annotated `@FunctionalInterface`). A **lambda** is a short way to implement it.

| Interface | Method | Meaning | Example |
|---|---|---|---|
| `Predicate<T>` | `boolean test(T)` | Test a condition | `s -> s.isEmpty()` |
| `Function<T,R>` | `R apply(T)` | Transform | `s -> s.length()` |
| `Consumer<T>` | `void accept(T)` | Use a value | `System.out::println` |
| `Supplier<T>` | `T get()` | Produce a value | `() -> new ArrayList<>()` |
| `BiFunction`, `UnaryOperator`, `BinaryOperator` | | Two-arg / same-type variants | |

**Internals:** lambdas are compiled using `invokedynamic`, not anonymous inner classes, so no extra `.class` file per lambda. Variables captured by a lambda must be **effectively final**. `this` inside a lambda refers to the enclosing class (unlike anonymous classes).

**Method references:** `String::length`, `System.out::println`, `Employee::new`.

## 4.2 Stream API

A stream is a **pipeline**: source → intermediate operations (lazy) → terminal operation (triggers execution). Streams do not store data and **cannot be reused**.

```java
List<String> result = employees.stream()          // source
    .filter(e -> e.salary > 50_000)               // intermediate
    .map(e -> e.name.toUpperCase())               // intermediate
    .sorted()                                     // intermediate (stateful)
    .collect(Collectors.toList());                // terminal
```

**Lazy evaluation:** nothing runs until the terminal operation; elements flow one by one through the whole pipeline (so `findFirst()` can short-circuit). `peek()` is for debugging only.

**map vs flatMap:** `map` is one-to-one; `flatMap` is one-to-many and flattens.

```java
List<List<Integer>> nested = Arrays.asList(Arrays.asList(1,2), Arrays.asList(3));
List<Integer> flat = nested.stream().flatMap(List::stream).collect(Collectors.toList()); // [1,2,3]
```

**Other points:**
* `findFirst()` respects order; `findAny()` is cheaper in parallel streams.
* `reduce(0, Integer::sum)` combines elements. For sum, prefer `mapToInt(...).sum()` (avoids boxing).
* `forEach` should have side effects only for output; do not mutate shared collections inside streams.

### Collectors

```java
Map<String, List<Employee>> byDept = emps.stream().collect(groupingBy(e -> e.dept));
Map<String, Double> avgSalary = emps.stream().collect(groupingBy(e -> e.dept, averagingDouble(e -> e.salary)));
Map<Boolean, List<Employee>> highLow = emps.stream().collect(partitioningBy(e -> e.salary > 80_000));
Map<Long, String> idToName = emps.stream().collect(toMap(e -> e.id, e -> e.name)); // throws on duplicate keys!
Map<String, Employee> topPerDept = emps.stream().collect(
    toMap(e -> e.dept, e -> e, BinaryOperator.maxBy(Comparator.comparingDouble(e -> e.salary))));
String names = emps.stream().map(e -> e.name).collect(joining(", ", "[", "]"));
```

**Trap:** `toMap` throws `IllegalStateException` on duplicate keys unless you supply a merge function.

## 4.3 Optional

```java
Optional<User> user = repo.findByEmail(email);
String name = user.map(User::getName).orElse("Guest");
String name2 = user.map(User::getName).orElseGet(() -> loadDefaultName()); // lazy
User u = user.orElseThrow(() -> new UserNotFoundException(email));
```

* `orElse(x)` **always evaluates `x`**; `orElseGet(supplier)` only if empty. Use `orElseGet` when the default is expensive (a DB call, `new` object).
* **Correct use:** return type of methods that may have no result.
* **Misuse:** as a field, as a method parameter, in entities, `Optional.get()` without `isPresent`, `Optional<List<X>>` (return an empty list instead), `optional.isPresent() ? optional.get() : null`.

## 4.4 Parallel streams

`list.parallelStream()` splits work across the common **ForkJoinPool**. It helps only for CPU-heavy, independent, stateless work on large, easily splittable data (arrays, `ArrayList`). It hurts with blocking I/O (starves the shared common pool), small data, `LinkedList`, shared mutable state, or when ordering matters. Measure first. In servers, avoid it for request handling.

## 4.5 Other Java 8 features

* **Default/static interface methods** allow adding methods to interfaces without breaking implementors (how `List.sort` was added).
* **Date/Time API (`java.time`)**: immutable and thread-safe — `LocalDate`, `LocalDateTime`, `Instant`, `ZonedDateTime`, `Duration`, `Period`, `DateTimeFormatter`. Replaces `Date`, `Calendar`, and the non-thread-safe `SimpleDateFormat`. Store timestamps as UTC `Instant`.
* **CompletableFuture** (see concurrency chapter).

```java
long days = ChronoUnit.DAYS.between(LocalDate.of(2024,1,1), LocalDate.now());
```

## 4.6 Java 8 coding questions

```java
// Second highest salary
Optional<Double> second = emps.stream().map(e -> e.salary).distinct()
        .sorted(Comparator.reverseOrder()).skip(1).findFirst();

// Highest paid per department
Map<String, Optional<Employee>> top = emps.stream()
        .collect(groupingBy(e -> e.dept, maxBy(Comparator.comparingDouble(e -> e.salary))));

// Count characters
Map<Character, Long> chars = "banana".chars().mapToObj(c -> (char) c)
        .collect(groupingBy(Function.identity(), counting()));

// Check palindrome
boolean pal = IntStream.range(0, s.length() / 2).allMatch(i -> s.charAt(i) == s.charAt(s.length() - 1 - i));

// Join non-empty names
String joined = Stream.of("a", "", "c").filter(s -> !s.isEmpty()).collect(joining("-"));
```

## 4.7 Java 9–21 feature timeline

| Version | Highlights |
|---|---|
| 9 | Modules (JPMS), `List.of/Set.of/Map.of`, private interface methods, `Optional.ifPresentOrElse` |
| 10 | `var` |
| 11 (LTS) | `String.isBlank/strip/lines/repeat`, new `HttpClient`, single-file run |
| 14 | Switch expressions |
| 15 | Text blocks |
| 16 | Records, pattern matching `instanceof`, `Stream.toList()` |
| 17 (LTS) | Sealed classes, strong encapsulation of JDK internals |
| 21 (LTS) | Virtual threads, pattern matching for switch, record patterns, sequenced collections |

**Compatibility implications:** Java 17 removed some internals access (`--add-opens` may be needed by old libraries); `javax.*` → `jakarta.*` for Jakarta EE 9+ (Spring Boot 3); upgrading from 8 → 17 is largely about libraries, Lombok/Mockito/Hibernate versions, and removed APIs (e.g., Nashorn JS engine, Java EE modules in the JDK).

**var:** only for locals with an obvious right-hand side; do not use when the type aids readability.
