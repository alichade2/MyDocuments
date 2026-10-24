# Part 1 — Java Core and OOP

## 1.1 JDK vs JRE vs JVM and how Java runs

**Interview question:** *Explain JDK, JRE and JVM. How does a `.java` file become a running program?*

**Simple answer:** The **JVM** runs bytecode. The **JRE** is the JVM plus the standard libraries needed to run programs. The **JDK** is the JRE plus developer tools such as `javac`, `jar`, `jshell` and `jcmd`. Source code is compiled by `javac` into platform-neutral **bytecode** (`.class` files); the JVM loads that bytecode and executes it, interpreting it and compiling hot parts to machine code with the **JIT compiler**.

**Understand it:**

```text
Hello.java --javac--> Hello.class (bytecode) --JVM--> machine code on Windows/Linux/Mac
                                   |
                         ClassLoader -> Verifier -> Interpreter + JIT -> Garbage Collector
```

1. `javac` checks syntax and types, then writes bytecode.
2. The **class loader** loads classes lazily, when first used.
3. The **bytecode verifier** checks the code is safe (no stack corruption, valid types).
4. The **interpreter** starts running immediately. The **JIT** (C1 and C2 in HotSpot) notices "hot" methods and compiles them to optimized native code.
5. The **GC** frees memory of unreachable objects.

**Platform independence:** your bytecode is portable; the *JVM* is platform specific. "Write once, run anywhere" means one bytecode, many JVMs.

**Real-life example:** Bytecode is like a sheet of music (same everywhere); the JVM is the musician who knows how to play it on a particular instrument (OS/CPU).

**Since Java 11** there is no separate JRE download from Oracle; use the JDK, or build a small runtime with `jlink`.

**Common mistakes:** saying "Java is purely interpreted" (JIT compiles hot code) or "JVM is platform independent" (it is not; bytecode is).

**Follow-ups:** What is JIT tiered compilation? What is `jlink`? What are Java's limitations (startup time, memory footprint, no manual memory control, verbose compared with some languages)?

**Interview-ready answer:** "javac compiles source to bytecode. The JVM loads that bytecode, verifies it, and runs it by interpreting and JIT-compiling hot methods to native code. The JDK includes the compiler and tools, the JRE is just the runtime, and the JVM is the engine inside. Bytecode is portable; each OS has its own JVM."

## 1.2 Primitive vs reference types, wrappers, autoboxing

**Interview question:** *What are the differences between primitives and wrapper classes? What problems does autoboxing cause?*

**Simple answer:** Primitives (`int`, `long`, `double`, `boolean`, ...) hold raw values and are fast. Wrappers (`Integer`, `Long`, ...) are objects, can be `null`, and work with generics and collections. Autoboxing converts between them automatically, but it can create garbage, hide `NullPointerException`s, and break `==` comparisons.

```java
Integer a = 127, b = 127;
System.out.println(a == b);       // true  (Integer cache -128..127)
Integer c = 1000, d = 1000;
System.out.println(c == d);       // false (different objects)
System.out.println(c.equals(d));  // true

Integer maybeNull = null;
int x = maybeNull;                // NullPointerException (unboxing)
```

**Explanation:** `Integer.valueOf()` returns cached objects for small values, so `==` accidentally works for 127 but not for 1000. Always use `equals()` for wrappers.

**Performance trap:** `Long sum = 0L; for (...) sum += i;` boxes a new `Long` on every iteration. Use `long`.

**Interview-ready answer:** "Primitives are values on the stack or inside objects; wrappers are objects needed for generics and nullability. Autoboxing is convenient but can cause hidden allocations, NPEs on unboxing null, and wrong `==` comparisons because of the Integer cache. I use primitives in hot loops and `equals()` on wrappers."

## 1.3 Pass-by-value

**Interview question:** *Is Java pass-by-value or pass-by-reference?*

**Simple answer:** Always **pass-by-value**. For objects, the *value of the reference* is copied, so both variables point to the same object.

```java
static void change(StringBuilder sb, int n) {
    sb.append(" world");      // modifies the shared object -> visible to caller
    sb = new StringBuilder("new"); // only changes local copy of the reference
    n = 99;                   // local copy only
}
public static void main(String[] args) {
    StringBuilder s = new StringBuilder("hello");
    int n = 1;
    change(s, n);
    System.out.println(s + " " + n);  // hello world 1
}
```

**Analogy:** You give a friend a *copy of your house address*. They can paint your house (mutate the object), but if they cross out their copy and write a new address, your address is unchanged.

## 1.4 `==` vs `equals()`, and the `equals`/`hashCode` contract

**Interview question:** *What is the contract between `equals()` and `hashCode()`? What breaks if you override only one?*

**Simple answer:** If two objects are `equals()`, they **must** have the same `hashCode()`. The reverse is not required. If you break this, hash-based collections (`HashMap`, `HashSet`) lose objects.

**The contract of `equals`:** reflexive, symmetric, transitive, consistent, and `x.equals(null)` is `false`.

```java
public final class Money {
    private final String currency;
    private final long cents;
    public Money(String currency, long cents) { this.currency = currency; this.cents = cents; }

    @Override public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Money)) return false;
        Money m = (Money) o;
        return cents == m.cents && currency.equals(m.currency);
    }
    @Override public int hashCode() { return java.util.Objects.hash(currency, cents); }
}
```

**What goes wrong if only `equals` is overridden:**

```java
Set<Money> set = new HashSet<>();
set.add(new Money("USD", 100));
set.contains(new Money("USD", 100)); // false! different hash -> different bucket
```

**Internals:** `HashMap` first uses `hashCode()` to find the bucket, then `equals()` to find the key within it.

**Common mistakes:** using mutable fields in `hashCode()` and then changing them after inserting into a `HashSet` (the object becomes "lost"); using `getClass()` vs `instanceof` inconsistently; for JPA entities see Part 7.

**Interview-ready answer:** "Equal objects must return equal hash codes because HashMap uses hashCode to choose the bucket and equals to confirm the match. Override both together, base them on the same immutable fields, and prefer records or Lombok where appropriate."

## 1.5 String immutability and the String pool

**Interview question:** *Why is `String` immutable? What is the String Constant Pool?*

**Simple answer:** A `String` object can never change after creation. This makes it **thread-safe**, **cacheable** (hash code computed once), **safe as a HashMap key** and **safe for security-sensitive values** like class names and file paths. The String pool is a JVM-managed cache of string literals so identical literals share one object.

```java
String a = "java";
String b = "java";
String c = new String("java");
System.out.println(a == b);          // true  (same pooled object)
System.out.println(a == c);          // false (new heap object)
System.out.println(a == c.intern()); // true
System.out.println(a.equals(c));     // true
```

**Internals:** Since Java 7 the pool lives on the heap (earlier in PermGen). `intern()` returns the pooled instance. Since Java 9, `String` is stored as `byte[]` (compact strings) when text is Latin-1, saving memory.

**Security note:** for passwords, prefer `char[]` because you can overwrite it; a `String` stays in memory until GC.

| | `String` | `StringBuilder` | `StringBuffer` |
|---|---|---|---|
| Mutable | No | Yes | Yes |
| Thread-safe | Yes (immutable) | No | Yes (synchronized) |
| Speed for repeated edits | Slow (new object each time) | Fastest | Slower due to locking |
| Use | Constants, keys | Single-thread building | Rarely needed today |

**Common trap:** `s1 + s2` in a loop creates many objects; use `StringBuilder`. A single-line `a + b + c` is fine — the compiler optimizes it (via `StringBuilder` or `invokedynamic` in Java 9+).

**Creating your own immutable class:** make the class `final`, fields `private final`, no setters, deep-copy mutable inputs in the constructor and defensive-copy on getters.

```java
public final class Appointment {
    private final String id;
    private final List<String> attendees;
    public Appointment(String id, List<String> attendees) {
        this.id = id;
        this.attendees = Collections.unmodifiableList(new ArrayList<>(attendees)); // defensive copy
    }
    public String getId() { return id; }
    public List<String> getAttendees() { return attendees; }
}
```

**Java 16+:** `record Appointment(String id, List<String> attendees) {}` is shallowly immutable — you still must copy the list in a compact constructor.

## 1.6 `final`, `finally`, `finalize()`

* `final` — variable cannot be reassigned, method cannot be overridden, class cannot be extended.
* `finally` — block that runs after try/catch, used for cleanup (prefer try-with-resources). It will not run if the JVM exits (`System.exit`) or crashes.
* `finalize()` — deprecated (Java 9) and deprecated for removal (Java 18). Unpredictable and slow. Use try-with-resources or `Cleaner`.

**Trap:** `return` inside `finally` swallows exceptions and overrides returned values. Never do it.

## 1.7 Static, initialization order, constructors

**Order of initialization** when you create `new Child()`:

1. Parent static blocks / static fields (once, when the class loads)
2. Child static blocks
3. Parent instance fields and instance initializer blocks
4. Parent constructor
5. Child instance fields and blocks
6. Child constructor

**Constructor chaining:** `this(...)` calls another constructor of the same class; `super(...)` calls the parent. Either must be the first statement (until Java 22 preview relaxations).

**Static methods** belong to the class, are not polymorphic (they are *hidden*, not overridden) and cannot access instance state.

## 1.8 Abstract class vs interface

| | Abstract class | Interface |
|---|---|---|
| State (instance fields) | Yes | No (only constants) |
| Constructors | Yes | No |
| Multiple inheritance | One class only | Many interfaces |
| Methods | abstract + concrete | abstract, `default`, `static`, `private` (Java 9) |
| Use for | Shared base state/behaviour ("is-a" with code reuse) | A capability/contract ("can do") |

**Rule of thumb:** program to interfaces; use an abstract class when subclasses truly share state or a template algorithm.

**Diamond problem with default methods:** if two interfaces provide the same default method, the class must override it, and can choose with `A.super.hello()`.

## 1.9 Overloading vs overriding; polymorphism

* **Overloading** — same name, different parameters, resolved at **compile time** (static polymorphism).
* **Overriding** — subclass replaces a parent method, resolved at **runtime** by the actual object type (dynamic dispatch, virtual method table).

```java
class Payment { void pay() { System.out.println("generic"); } }
class CardPayment extends Payment { @Override void pay() { System.out.println("card"); } }
Payment p = new CardPayment();
p.pay(); // card -> chosen at runtime from the object's real class
```

**Overriding rules:** same signature; return type may be a subtype (covariant); cannot reduce visibility; cannot throw broader checked exceptions; `private`, `static`, `final` methods cannot be overridden. Always use `@Override`.

## 1.10 Composition vs inheritance; association, aggregation, composition

**Simple answer:** Inheritance is **"is-a"**, composition is **"has-a"**. Prefer composition because inheritance couples the child to the parent's implementation (the "fragile base class" problem) and is fixed at compile time.

| Relationship | Meaning | Lifetime | Example |
|---|---|---|---|
| Association | Uses | Independent | Doctor — Patient |
| Aggregation | Has, weak | Part can outlive whole | Department — Employee |
| Composition | Owns, strong | Part dies with whole | Order — OrderLine |

```java
// Composition + interface: behaviour is swappable
interface NotificationSender { void send(String to, String msg); }
class OrderService {
    private final NotificationSender sender;           // has-a
    OrderService(NotificationSender sender) { this.sender = sender; }
    void confirm(String email) { sender.send(email, "Order confirmed"); }
}
```

## 1.11 Shallow vs deep copy, cloning

* **Shallow copy** copies field values; nested objects are shared.
* **Deep copy** recursively copies nested objects.

`Object.clone()` is awkward (needs `Cloneable`, shallow by default, bypasses constructors, throws checked exception). Prefer **copy constructors** or static factories, or serialization/mapping libraries for deep copies.

```java
class Address { String city; Address(Address a) { this.city = a.city; } Address(String c){city=c;} }
class Customer {
    String name; Address address;
    Customer(Customer c) { this.name = c.name; this.address = new Address(c.address); } // deep copy
}
```

## 1.12 Marker interfaces, annotations, enums, nested classes

* **Marker interface** has no methods (`Serializable`, `Cloneable`) and tags a class. Annotations are the modern, more flexible way to add metadata.
* **Annotations** are metadata read at compile time (Lombok, `@Override`) or runtime via reflection (Spring `@Component`). Retention: `SOURCE`, `CLASS`, `RUNTIME`.
* **Enums** are full classes with fixed instances; can have fields, constructors, methods and implement interfaces. They are the safest singleton and work well with `switch` and `EnumMap`.
* **Nested classes:** *static nested* (no outer instance), *inner* (holds a hidden reference to the outer instance — can cause memory leaks), *local*, *anonymous*. Prefer static nested unless you need the outer instance.

```java
enum OrderStatus {
    NEW(false), PAID(false), SHIPPED(false), CANCELLED(true);
    private final boolean terminal;
    OrderStatus(boolean terminal) { this.terminal = terminal; }
    public boolean isTerminal() { return terminal; }
}
```

## 1.13 Serialization, `transient`, `volatile`

* **Serialization** converts an object to bytes. Implement `Serializable` and declare `serialVersionUID` so versions stay compatible.
* `transient` fields are skipped (passwords, caches).
* **Security warning:** Java native deserialization of untrusted data is a well-known attack vector. Prefer JSON (Jackson) or Protobuf; if you must use it, apply serialization filters.
* `volatile` guarantees **visibility** and ordering of a variable between threads, not atomicity (see concurrency chapter).

## 1.14 Records and modern language features (Java 14–21)

| Feature | Version (final) | One-line use |
|---|---|---|
| `var` local type inference | 10 | Less boilerplate for locals |
| Switch expressions | 14 | `case X -> value;` returns a value |
| Text blocks | 15 | Multi-line strings `"""` |
| Records | 16 | Immutable data carriers |
| Pattern matching `instanceof` | 16 | `if (o instanceof String s)` |
| Sealed classes | 17 | Restrict which classes may extend |
| Pattern matching for `switch` | 21 | Type patterns in switch |
| Record patterns | 21 | Destructure records |
| Virtual threads | 21 | Lightweight threads |

```java
record Point(int x, int y) {
    Point { if (x < 0) throw new IllegalArgumentException("x"); } // compact constructor
}
sealed interface Shape permits Circle, Square {}
record Circle(double r) implements Shape {}
record Square(double s) implements Shape {}

static double area(Shape s) {          // Java 21
    return switch (s) {
        case Circle c -> Math.PI * c.r() * c.r();
        case Square q -> q.s() * q.s();
    };
}
```

**Compatibility:** Spring Boot 3 requires Java 17. If your company is on Java 8 or 11, know the features above exist but do not use them in code labelled Java 8.

---

# Part 2 — OOP and Design Principles

## 2.1 The four pillars

| Pillar | Meaning | Example |
|---|---|---|
| **Encapsulation** | Hide state, expose behaviour | `BankAccount.withdraw()` checks balance; balance field is private |
| **Abstraction** | Show *what*, hide *how* | `PaymentGateway.pay()` hides the bank API details |
| **Inheritance** | Reuse and extend a type | `SavingsAccount extends Account` |
| **Polymorphism** | One interface, many behaviours | `List` can be an `ArrayList` or `LinkedList` |

```java
public class BankAccount {
    private long balanceCents;                      // encapsulation
    public void withdraw(long amount) {
        if (amount <= 0 || amount > balanceCents) throw new IllegalArgumentException("Invalid amount");
        balanceCents -= amount;
    }
}
```

## 2.2 SOLID with enterprise examples

**S — Single Responsibility:** a class has one reason to change. `OrderService` should not also render PDFs and send emails; delegate to `InvoiceRenderer` and `EmailNotifier`.

**O — Open/Closed:** extend behaviour without editing tested code.

```java
interface DiscountPolicy { double apply(double total); }
class FestivalDiscount implements DiscountPolicy { public double apply(double t){ return t*0.9; } }
class NoDiscount implements DiscountPolicy { public double apply(double t){ return t; } }
// Adding a new policy = a new class; Checkout never changes.
```

**L — Liskov Substitution:** a subtype must work wherever the parent is expected. The classic violation: `Square extends Rectangle` where `setWidth` also changes height. Or a `ReadOnlyList extends List` that throws on `add()`.

**I — Interface Segregation:** many small interfaces beat one fat one. A `Printer` should not be forced to implement `fax()`.

**D — Dependency Inversion:** high-level modules depend on abstractions. `OrderService` depends on `PaymentGateway` (interface), not `StripeClient`. Spring's DI container makes this natural.

## 2.3 Other principles

* **DRY** — one source of truth for each piece of knowledge. Do not over-DRY: two similar-looking pieces of code that change for different reasons should stay separate.
* **KISS** — simplest design that works.
* **YAGNI** — do not build what you do not need yet.
* **Low coupling, high cohesion** — classes should know little about each other and each class should do one focused thing.
* **Program to an interface** — makes testing (mocking) and replacement easy.

## 2.4 Spotting and fixing poor design

| Smell | Symptom | Fix |
|---|---|---|
| God class | 3000-line `OrderManager` | Split by responsibility |
| Feature envy | Method uses another class's data more than its own | Move the method |
| Long parameter list | 10 arguments | Parameter object / Builder |
| Primitive obsession | Strings for money/email | Value objects (`Money`, `Email`) |
| Anemic domain model | Entities are only getters/setters; logic in giant services | Move invariants into entities |
| Switch on type | `if (type == CARD) ... else if ...` | Strategy / polymorphism |
| Hidden dependencies | `new` inside methods, static singletons | Dependency injection |

**Interview-ready answer:** "I look at responsibilities and dependencies. If a class has several reasons to change or hard-wired dependencies, I extract interfaces, inject dependencies, and apply patterns like Strategy. I protect the refactoring with tests first, then change in small safe steps."
