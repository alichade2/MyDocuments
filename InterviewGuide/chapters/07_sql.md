# Part 13 — SQL and Database Concepts

## 13.1 Fundamentals

* **DDL** (define structure): `CREATE`, `ALTER`, `DROP`, `TRUNCATE`. **DML** (change data): `INSERT`, `UPDATE`, `DELETE`, `MERGE`. **DQL:** `SELECT`. **DCL** (permissions): `GRANT`, `REVOKE`. **TCL** (transactions): `COMMIT`, `ROLLBACK`, `SAVEPOINT`.
* **Primary key:** uniquely identifies a row, not null, one per table. **Foreign key:** references a primary/unique key in another table and enforces referential integrity. **Unique constraint:** no duplicate values (nulls handling differs by database).
* **ACID:** **A**tomicity (all or nothing), **C**onsistency (constraints always hold), **I**solation (concurrent transactions do not see each other's partial work), **D**urability (committed data survives crashes, via the write-ahead log).
* **Normalization** removes redundancy: **1NF** atomic values, no repeating groups; **2NF** no partial dependency on part of a composite key; **3NF** no transitive dependency (non-key columns depend only on the key). **Denormalization** deliberately duplicates data to speed reads (reporting, read models) at the cost of update complexity.

## 13.2 Sample data used in the problems

```sql
CREATE TABLE department (id INT PRIMARY KEY, name VARCHAR(50));
CREATE TABLE employee (
  id INT PRIMARY KEY, name VARCHAR(50), salary INT, dept_id INT, manager_id INT);

INSERT INTO department VALUES (1,'Engineering'),(2,'Sales'),(3,'HR');
INSERT INTO employee VALUES
 (1,'Asha',  150, 1, NULL),
 (2,'Ravi',  120, 1, 1),
 (3,'Meena', 120, 1, 1),
 (4,'John',   90, 2, 1),
 (5,'Sara',  160, 2, 4),
 (6,'Tom',    70, 2, 4),
 (7,'Lee',    60, NULL, 1);
```

## 13.3 Joins

| Join | Returns |
|---|---|
| `INNER JOIN` | Only rows that match in both tables |
| `LEFT JOIN` | All left rows; right columns are NULL if no match |
| `RIGHT JOIN` | All right rows (mirror of left) |
| `FULL OUTER JOIN` | All rows from both sides (not in MySQL) |
| `CROSS JOIN` | Every combination (cartesian product) |

```sql
-- Employees with department name (Lee has no department -> use LEFT JOIN to keep him)
SELECT e.name, d.name AS dept FROM employee e LEFT JOIN department d ON d.id = e.dept_id;

-- Departments without employees (the "missing records" pattern)
SELECT d.name FROM department d LEFT JOIN employee e ON e.dept_id = d.id WHERE e.id IS NULL;
-- Output: HR
```

**Trap:** a condition on the right table in `WHERE` turns a LEFT JOIN into an INNER JOIN; put it in the `ON` clause instead.

## 13.4 GROUP BY, HAVING and aggregates

`WHERE` filters rows **before** grouping; `HAVING` filters groups **after** aggregation. Logical order: `FROM → WHERE → GROUP BY → HAVING → SELECT → ORDER BY → LIMIT`. `COUNT(*)` counts rows; `COUNT(col)` ignores NULLs.

```sql
-- Departments with more than 2 employees
SELECT dept_id, COUNT(*) AS cnt FROM employee GROUP BY dept_id HAVING COUNT(*) > 2;
-- Output: dept 1 -> 3
```

## 13.5 Classic problems

**1. Second highest salary**

```sql
-- Works on all databases; returns NULL if there is no second value
SELECT MAX(salary) AS second_highest FROM employee WHERE salary < (SELECT MAX(salary) FROM employee);
-- Output: 150   (salaries are 160,150,120,120,90,70,60)

-- Nth highest with DENSE_RANK (N=2)
SELECT DISTINCT salary FROM (
  SELECT salary, DENSE_RANK() OVER (ORDER BY salary DESC) rk FROM employee) t WHERE rk = 2;
```

**2. Duplicate records**

```sql
SELECT name, COUNT(*) FROM employee GROUP BY name HAVING COUNT(*) > 1;

-- Delete duplicates keeping the lowest id (portable form)
DELETE FROM employee WHERE id NOT IN (SELECT MIN(id) FROM employee GROUP BY name);
-- (MySQL needs the subquery wrapped in a derived table.)
```

**3. Highest salary per department (department-wise maximum)**

```sql
SELECT d.name, MAX(e.salary) AS max_salary
FROM employee e JOIN department d ON d.id = e.dept_id GROUP BY d.name;
-- Engineering 150, Sales 160
```

**4. Top N per group (top 2 earners in each department)**

```sql
SELECT * FROM (
  SELECT e.*, ROW_NUMBER() OVER (PARTITION BY dept_id ORDER BY salary DESC) rn
  FROM employee e WHERE dept_id IS NOT NULL) t
WHERE rn <= 2;
-- Engineering: Asha 150, Ravi 120 (Meena tied; ROW_NUMBER picks one arbitrarily)
-- Use DENSE_RANK() to keep ties.
```

**5. Employees earning more than their manager**

```sql
SELECT e.name, e.salary, m.name AS manager, m.salary AS manager_salary
FROM employee e JOIN employee m ON m.id = e.manager_id WHERE e.salary > m.salary;
-- Sara (160) earns more than manager John (90)
```

**6. Ranking functions**

| Function | Ties | Example for salaries 160,150,120,120,90 |
|---|---|---|
| `ROW_NUMBER()` | Unique numbers | 1,2,3,4,5 |
| `RANK()` | Same rank, **gaps** after ties | 1,2,3,3,5 |
| `DENSE_RANK()` | Same rank, **no gaps** | 1,2,3,3,4 |

```sql
SELECT name, salary, RANK() OVER (ORDER BY salary DESC) r, DENSE_RANK() OVER (ORDER BY salary DESC) dr
FROM employee;
```

**7. Running total, previous row**

```sql
SELECT id, salary, SUM(salary) OVER (ORDER BY id) running, LAG(salary) OVER (ORDER BY id) prev FROM employee;
```

**8. CTE (readable, can be recursive)**

```sql
WITH dept_avg AS (SELECT dept_id, AVG(salary) a FROM employee GROUP BY dept_id)
SELECT e.name FROM employee e JOIN dept_avg d ON d.dept_id = e.dept_id WHERE e.salary > d.a;

-- Recursive: management chain below Asha (id 1)
WITH RECURSIVE chain AS (
  SELECT id, name, manager_id, 1 lvl FROM employee WHERE id = 1
  UNION ALL
  SELECT e.id, e.name, e.manager_id, c.lvl + 1 FROM employee e JOIN chain c ON e.manager_id = c.id)
SELECT * FROM chain;
```

**9. Missing records / gaps:** `NOT EXISTS` is usually the safest anti-join.

```sql
SELECT d.name FROM department d WHERE NOT EXISTS (SELECT 1 FROM employee e WHERE e.dept_id = d.id);
```
(`NOT IN` returns nothing if the subquery contains a NULL — a classic trap.)

**10. Subqueries:** *scalar* (one value), *correlated* (refers to the outer row, runs per row logically — can be slow; often rewritten as a join/window function).

```sql
-- Employees earning above their department average (correlated)
SELECT name FROM employee e WHERE salary > (SELECT AVG(salary) FROM employee WHERE dept_id = e.dept_id);
```

## 13.6 Indexes and execution plans

* An **index** is a separate sorted structure (usually a **B-tree**) that lets the database find rows without scanning the whole table. Costs: extra storage and slower writes (every index must be updated).
* **Clustered index** (e.g., SQL Server, MySQL InnoDB primary key): the table rows are physically organized by the index key — one per table. **Non-clustered/secondary:** a separate structure pointing to rows (in InnoDB it points to the primary key). PostgreSQL tables are heaps; indexes are all secondary (`CLUSTER` is a one-time reorder).
* **Composite index and column order:** an index on `(dept_id, salary)` supports queries filtering on `dept_id`, or `dept_id` + `salary` (the **leftmost prefix** rule), but not `salary` alone. Put equality columns first, range column last; consider sort order.
* **Selectivity:** how well a column narrows rows (unique email = high; boolean flag = low). Indexes on low-selectivity columns are often ignored.
* **Covering index:** includes all columns the query needs, so no table lookup is required.
* **Why an index might not be used:** function on the column (`WHERE LOWER(email)=...`), implicit type conversion, leading wildcard `LIKE '%abc'`, low selectivity, stale statistics, OR conditions.
* **Execution plan:** `EXPLAIN` / `EXPLAIN ANALYZE`. Look for full table scans on big tables, wrong join order, big gaps between estimated and actual rows, sorts spilling to disk, nested loops over large sets.

**Slow-query optimization checklist:** (1) get the plan; (2) add/fix the right index; (3) select only needed columns; (4) avoid N+1 queries from the app; (5) paginate with keyset instead of large `OFFSET`; (6) update statistics; (7) rewrite subqueries/functions on indexed columns; (8) consider caching, partitioning, or a read replica; (9) check lock waits.

## 13.7 Locks, deadlocks, procedures, scale-out

* **Optimistic vs pessimistic locking:** see Part 10. Database-level: `SELECT ... FOR UPDATE` (pessimistic), version column / compare-and-set (optimistic). Also `SKIP LOCKED` for job-queue tables.
* **Database deadlock:** two transactions wait for each other's locks; the DB aborts one (retry it). Reduce by accessing rows in a consistent order, keeping transactions short, and indexing the filtering columns (to lock fewer rows).
* **Stored procedures/triggers:** server-side logic. Pros: fewer round trips, close to data. Cons: harder to version/test/debug, business logic hidden, vendor lock-in. Triggers can surprise developers; prefer explicit application logic or auditing frameworks unless there is a reason.
* **Connection pooling:** opening connections is expensive; a pool reuses them (HikariCP). Pool size is bounded by what the database can serve.
* **Replication:** a primary accepts writes and replicas copy them (async or sync); read replicas scale reads but have **replication lag** (stale reads). **Partitioning** splits a big table inside one database (by range/hash/list) to prune scans and ease maintenance; **sharding** distributes data across **multiple databases/servers** (hard: cross-shard joins/transactions, rebalancing).
* **SQL vs NoSQL:** relational databases give schema, joins and strong ACID transactions — default for transactional business data. NoSQL families: **document** (MongoDB: flexible schema, nested data), **key-value** (Redis, DynamoDB: simple fast lookups), **wide-column** (Cassandra: huge write throughput, designed around queries), **graph** (Neo4j). Choose NoSQL for a specific access pattern or scale need, not by fashion; many systems use polyglot persistence.
* **Isolation levels** are covered in Part 10.

---

# Part 14 — Coding Interview Problems

> Format for each problem: statement → example → assumptions → brute force → optimized approach → **Java 8 compilable code** → explanation → dry run → complexity → edge cases → follow-ups. Easy and Medium first, a few harder ones last.

**Big-O in one minute:** Big-O describes how time or space grows with input size `n`, ignoring constants: O(1) < O(log n) < O(n) < O(n log n) < O(n²) < O(2ⁿ). It is the *upper bound trend*, not the exact speed. Interviewers expect you to state time **and** space for every solution.

## 14.1 Two Sum (Easy) — HashMap

**Statement:** Given an int array `nums` and `target`, return indices of two numbers adding up to `target`. **Example:** `[2,7,11,15], 9 → [0,1]`. **Assumptions:** exactly one answer; same element cannot be used twice.

**Brute force:** check all pairs: O(n²) time, O(1) space.

**Optimized:** one pass; for each number look for its **complement** (`target - x`) in a map of already-seen values: O(n) time, O(n) space.

```java
import java.util.*;

public class TwoSum {
    public static int[] twoSum(int[] nums, int target) {
        Map<Integer, Integer> seen = new HashMap<>();          // value -> index
        for (int i = 0; i < nums.length; i++) {
            int need = target - nums[i];
            if (seen.containsKey(need)) return new int[]{seen.get(need), i};
            seen.put(nums[i], i);                               // store after checking so we do not reuse the same element
        }
        throw new IllegalArgumentException("No solution");
    }
    public static void main(String[] a) { System.out.println(Arrays.toString(twoSum(new int[]{2,7,11,15}, 9))); }
}
```

**Dry run:** i=0, x=2, need 7, map empty → store {2:0}. i=1, x=7, need 2 → found at index 0 → `[0,1]`.
**Edge cases:** duplicates (`[3,3], 6`), negatives, no solution, empty array. **Follow-ups:** sorted input → two pointers O(1) space; return all pairs; count pairs; Three Sum.

## 14.2 Remove duplicates from a sorted array in place (Easy) — two pointers

**Example:** `[1,1,2,2,3] → length 3, array starts [1,2,3]`.

```java
public static int removeDuplicates(int[] a) {
    if (a.length == 0) return 0;
    int write = 1;                                  // next position to write a unique value
    for (int read = 1; read < a.length; read++) {
        if (a[read] != a[read - 1]) a[write++] = a[read];
    }
    return write;
}
```

**Dry run:** `[1,1,2,2,3]` → read=2 (2≠1) a[1]=2,w=2; read=4 (3≠2) a[2]=3,w=3 → returns 3. **Complexity:** O(n) time, O(1) space. **Edge cases:** empty, all equal, no duplicates. **Follow-up:** allow at most two duplicates (compare with `a[write-2]`). **Remove Element** (value `val`) is the same pattern: `if (a[read] != val) a[write++] = a[read];`.

## 14.3 Reverse a string and Palindrome (Easy)

```java
public static String reverse(String s) {
    char[] c = s.toCharArray();
    for (int i = 0, j = c.length - 1; i < j; i++, j--) { char t = c[i]; c[i] = c[j]; c[j] = t; }
    return new String(c);                           // O(n) time, O(n) space (strings are immutable)
}

public static boolean isPalindrome(String s) {      // ignoring case and non-alphanumerics
    int i = 0, j = s.length() - 1;
    while (i < j) {
        while (i < j && !Character.isLetterOrDigit(s.charAt(i))) i++;
        while (i < j && !Character.isLetterOrDigit(s.charAt(j))) j--;
        if (Character.toLowerCase(s.charAt(i++)) != Character.toLowerCase(s.charAt(j--))) return false;
    }
    return true;                                    // O(n) time, O(1) space
}
```
**Dry run** `"A man, a plan"` style: pointers skip punctuation and compare lowercase letters. **Edge cases:** empty string, single char, only punctuation (true), null input.

## 14.4 Valid Anagram, First Non-Repeating Character, Character Frequency (Easy)

```java
public static boolean isAnagram(String a, String b) {
    if (a.length() != b.length()) return false;
    int[] cnt = new int[26];                        // assumes lowercase a-z; use a HashMap for Unicode
    for (int i = 0; i < a.length(); i++) { cnt[a.charAt(i) - 'a']++; cnt[b.charAt(i) - 'a']--; }
    for (int n : cnt) if (n != 0) return false;
    return true;                                    // O(n) time, O(1) space
}

public static int firstUniqueIndex(String s) {      // "leetcode" -> 0, "aabb" -> -1
    int[] cnt = new int[256];
    for (char c : s.toCharArray()) cnt[c]++;
    for (int i = 0; i < s.length(); i++) if (cnt[s.charAt(i)] == 1) return i;
    return -1;
}

public static Map<Character, Integer> frequency(String s) {
    Map<Character, Integer> m = new TreeMap<>();
    for (char c : s.toCharArray()) m.merge(c, 1, Integer::sum);
    return m;
}
```
**Brute force for first unique:** for each char scan the rest, O(n²). **Follow-ups:** Unicode/streaming input; return the character; case-insensitive.

## 14.5 Find duplicates and Group Anagrams (Medium)

```java
public static List<List<String>> groupAnagrams(String[] words) {
    Map<String, List<String>> groups = new HashMap<>();
    for (String w : words) {
        char[] c = w.toCharArray();
        Arrays.sort(c);                             // sorted letters = canonical key
        groups.computeIfAbsent(new String(c), k -> new ArrayList<>()).add(w);
    }
    return new ArrayList<>(groups.values());
}
```
**Example:** `["eat","tea","tan","ate","nat","bat"] → [[eat,tea,ate],[tan,nat],[bat]]`. **Complexity:** O(n·k log k) for n words of length k; space O(n·k). **Optimization:** use a 26-count signature as the key for O(n·k). **Edge cases:** empty strings, single word, uppercase.

## 14.6 Longest Substring Without Repeating Characters (Medium) — sliding window

**Example:** `"abcabcbb" → 3 ("abc")`. **Brute force:** check every substring, O(n³) (or O(n²) with sets). **Optimized:** keep a window `[left, right]` with no duplicates; store each char's last index; when a repeat appears inside the window, jump `left` past its previous position.

```java
public static int lengthOfLongestSubstring(String s) {
    Map<Character, Integer> last = new HashMap<>();
    int best = 0, left = 0;
    for (int right = 0; right < s.length(); right++) {
        char c = s.charAt(right);
        if (last.containsKey(c) && last.get(c) >= left) left = last.get(c) + 1;   // shrink past the duplicate
        last.put(c, right);
        best = Math.max(best, right - left + 1);
    }
    return best;                                    // O(n) time, O(min(n, alphabet)) space
}
```
**Dry run `abcabcbb`:** a,b,c → len 3; right=3 'a' seen at 0 ≥ left 0 → left=1, len 3; … the best stays 3. **Edge cases:** empty, all same (`"bbbb"` → 1), `"abba"` (the `>= left` check matters: at the final 'a', its last index 0 < left 2, so we must not move left backward).

## 14.7 Merge Intervals (Medium) — sort

**Example:** `[[1,3],[2,6],[8,10],[15,18]] → [[1,6],[8,10],[15,18]]`.

```java
public static int[][] merge(int[][] in) {
    if (in.length <= 1) return in;
    Arrays.sort(in, (x, y) -> Integer.compare(x[0], y[0]));      // avoid x[0]-y[0] overflow
    List<int[]> out = new ArrayList<>();
    int[] cur = in[0];
    for (int i = 1; i < in.length; i++) {
        if (in[i][0] <= cur[1]) cur[1] = Math.max(cur[1], in[i][1]);   // overlap -> extend
        else { out.add(cur); cur = in[i]; }
    }
    out.add(cur);
    return out.toArray(new int[0][]);               // O(n log n) time, O(n) space
}
```
**Edge cases:** touching intervals `[1,4],[4,5]` merge; one interval contained in another; unsorted input; empty. **Follow-up:** Insert Interval, meeting rooms (min-heap on end times).

## 14.8 Binary Search (Easy)

```java
public static int binarySearch(int[] a, int target) {          // sorted ascending
    int lo = 0, hi = a.length - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;                           // avoids int overflow of (lo+hi)/2
        if (a[mid] == target) return mid;
        if (a[mid] < target) lo = mid + 1; else hi = mid - 1;
    }
    return -1;                                                  // O(log n) time, O(1) space
}
```
**Dry run** `[1,3,5,7,9], 7`: lo0 hi4 mid2(5)<7 → lo3; mid3(7) found. **Follow-ups:** first/last occurrence, rotated sorted array, search on answer ("minimum capacity to ship in D days"). **Common bug:** infinite loops from wrong bounds (`lo < hi` vs `<=`).

## 14.9 Linked lists: Reverse and Detect Cycle (Easy)

```java
class ListNode { int val; ListNode next; ListNode(int v) { val = v; } }

public static ListNode reverse(ListNode head) {
    ListNode prev = null, cur = head;
    while (cur != null) {
        ListNode next = cur.next;                    // remember the rest
        cur.next = prev;                             // flip the link
        prev = cur; cur = next;
    }
    return prev;                                     // O(n) time, O(1) space
}

public static boolean hasCycle(ListNode head) {      // Floyd's tortoise and hare
    ListNode slow = head, fast = head;
    while (fast != null && fast.next != null) {
        slow = slow.next; fast = fast.next.next;
        if (slow == fast) return true;
    }
    return false;                                    // O(n) time, O(1) space (a HashSet approach is O(n) space)
}
```
**Dry run reverse `1→2→3`:** prev=null; cur=1: 1.next=null; cur=2: 2.next=1; cur=3: 3.next=2 → head 3→2→1. **Edge cases:** empty list, one node. **Follow-ups:** find the cycle's start (reset one pointer to head, move both one step), find middle, merge two sorted lists, recursive reverse (stack depth O(n)).

## 14.10 Valid Parentheses (Easy) — stack

```java
public static boolean isValid(String s) {
    Deque<Character> st = new ArrayDeque<>();
    for (char c : s.toCharArray()) {
        if (c == '(') st.push(')'); else if (c == '[') st.push(']'); else if (c == '{') st.push('}');
        else if (st.isEmpty() || st.pop() != c) return false;    // closing bracket must match latest opener
    }
    return st.isEmpty();                              // O(n) time, O(n) space
}
```
**Dry run `"([)]"`:** push `)`, push `]`; read `)` → pop `]` ≠ `)` → false. **Edge cases:** empty string (true), only closers, leftover openers.

## 14.11 Merge Sorted Arrays (Easy)

```java
public static int[] mergeSorted(int[] a, int[] b) {
    int[] r = new int[a.length + b.length];
    int i = 0, j = 0, k = 0;
    while (i < a.length && j < b.length) r[k++] = a[i] <= b[j] ? a[i++] : b[j++];
    while (i < a.length) r[k++] = a[i++];
    while (j < b.length) r[k++] = b[j++];
    return r;                                          // O(n+m) time and space
}
```
**In-place variant (LeetCode 88):** fill from the **end** of the bigger array so you do not overwrite unread values.

## 14.12 Kth Largest and Top K Frequent (Medium) — heap

```java
public static int kthLargest(int[] nums, int k) {
    PriorityQueue<Integer> minHeap = new PriorityQueue<>();     // holds the k largest seen so far
    for (int n : nums) { minHeap.offer(n); if (minHeap.size() > k) minHeap.poll(); }
    return minHeap.peek();                                       // O(n log k) time, O(k) space
}

public static List<Integer> topKFrequent(int[] nums, int k) {
    Map<Integer, Integer> freq = new HashMap<>();
    for (int n : nums) freq.merge(n, 1, Integer::sum);
    PriorityQueue<Map.Entry<Integer, Integer>> pq = new PriorityQueue<>((x, y) -> x.getValue() - y.getValue());
    for (Map.Entry<Integer, Integer> e : freq.entrySet()) { pq.offer(e); if (pq.size() > k) pq.poll(); }
    List<Integer> res = new ArrayList<>();
    while (!pq.isEmpty()) res.add(pq.poll().getKey());
    return res;                                                  // O(n log k)
}
```
**Brute force:** sort everything O(n log n). **Alternatives:** QuickSelect O(n) average; bucket sort by frequency O(n) for Top-K Frequent. **Dry run** `[3,2,1,5,6,4], k=2`: heap keeps {5,6} → peek 5.

## 14.13 Tree traversals (Easy–Medium)

```java
class TreeNode { int val; TreeNode left, right; TreeNode(int v) { val = v; } }

static void inorder(TreeNode n, List<Integer> out) {            // left, root, right: sorted order for a BST
    if (n == null) return;
    inorder(n.left, out); out.add(n.val); inorder(n.right, out);
}

static List<List<Integer>> levelOrder(TreeNode root) {          // BFS with a queue
    List<List<Integer>> res = new ArrayList<>();
    if (root == null) return res;
    Queue<TreeNode> q = new ArrayDeque<>(); q.offer(root);
    while (!q.isEmpty()) {
        int size = q.size();                                     // nodes on this level
        List<Integer> level = new ArrayList<>();
        for (int i = 0; i < size; i++) {
            TreeNode n = q.poll(); level.add(n.val);
            if (n.left != null) q.offer(n.left);
            if (n.right != null) q.offer(n.right);
        }
        res.add(level);
    }
    return res;                                                  // O(n) time, O(width) space
}

static int maxDepth(TreeNode n) { return n == null ? 0 : 1 + Math.max(maxDepth(n.left), maxDepth(n.right)); }

static boolean isValidBST(TreeNode n, long lo, long hi) {       // call with Long.MIN_VALUE, Long.MAX_VALUE
    if (n == null) return true;
    if (n.val <= lo || n.val >= hi) return false;
    return isValidBST(n.left, lo, n.val) && isValidBST(n.right, n.val, hi);
}
```
Preorder = root, left, right; postorder = left, right, root. Recursion depth is O(height) (O(n) for a skewed tree → use an explicit stack for very deep trees). **Common mistake in BST validation:** only comparing a node with its direct children.

## 14.14 Find Missing Number and Maximum Subarray (Easy / Medium)

```java
public static int missingNumber(int[] nums) {                    // numbers 0..n with one missing
    int n = nums.length;
    long expected = (long) n * (n + 1) / 2, sum = 0;
    for (int x : nums) sum += x;
    return (int) (expected - sum);                               // O(n) time, O(1) space; XOR also works
}

public static int maxSubArray(int[] a) {                         // Kadane's algorithm
    int cur = a[0], best = a[0];
    for (int i = 1; i < a.length; i++) {
        cur = Math.max(a[i], cur + a[i]);                        // extend the current run or start fresh
        best = Math.max(best, cur);
    }
    return best;                                                 // O(n) time, O(1) space
}
```
**Kadane dry run `[-2,1,-3,4,-1,2,1,-5,4]`:** cur: -2,1,-2,4,3,5,6,1,5 → best 6 (subarray `4,-1,2,1`). **Edge cases:** all negatives (answer is the largest single element — why `cur` starts at `a[0]`, not 0), one element. **Follow-up:** return the subarray indices; circular array.

## 14.15 Recursion, graphs and dynamic programming (basics)

```java
// Fibonacci: naive recursion O(2^n); memoization/DP O(n)
static long fib(int n) { if (n < 2) return n; long a = 0, b = 1; for (int i = 2; i <= n; i++) { long t = a + b; a = b; b = t; } return b; }

// Climbing stairs (1 or 2 steps): ways(n) = ways(n-1) + ways(n-2)

// Graph BFS - shortest path in an unweighted graph
static int shortestPath(Map<Integer, List<Integer>> g, int s, int t) {
    Queue<Integer> q = new ArrayDeque<>(); Map<Integer, Integer> dist = new HashMap<>();
    q.offer(s); dist.put(s, 0);
    while (!q.isEmpty()) {
        int u = q.poll();
        if (u == t) return dist.get(u);
        for (int v : g.getOrDefault(u, Collections.<Integer>emptyList()))
            if (!dist.containsKey(v)) { dist.put(v, dist.get(u) + 1); q.offer(v); }
    }
    return -1;
}

// Coin change (min coins), bottom-up DP: dp[x] = min(dp[x - coin] + 1)
static int coinChange(int[] coins, int amount) {
    int[] dp = new int[amount + 1]; Arrays.fill(dp, amount + 1); dp[0] = 0;
    for (int x = 1; x <= amount; x++) for (int c : coins) if (c <= x) dp[x] = Math.min(dp[x], dp[x - c] + 1);
    return dp[amount] > amount ? -1 : dp[amount];                // O(amount * coins)
}
```
**DP recipe:** define the state, write the recurrence, set the base case, choose the order (memoize top-down or tabulate bottom-up), then optimize space. **Graph basics:** BFS (queue) for shortest unweighted path and levels; DFS (stack/recursion) for connectivity, cycles, topological sort; Dijkstra (priority queue) for weighted non-negative edges. Always handle **visited** sets to avoid infinite loops.

## 14.16 Modern Java alternatives (Java 17+)

```java
// Frequency in one expression (Java 8 style works on all versions; var and toList need newer)
var freq = "banana".chars().mapToObj(c -> (char) c).collect(Collectors.groupingBy(Function.identity(), Collectors.counting()));
List<Integer> evens = Stream.of(1,2,3,4).filter(n -> n % 2 == 0).toList();   // Java 16+, immutable
record Pair(int i, int j) {}                                                  // clean result type for Two Sum variants
```

**Interview coding tips for seniors:** clarify the requirements; start with a brute-force idea, then optimize and say why; name variables clearly; state complexity unprompted; test with edge cases aloud (empty, one element, duplicates, negatives, large inputs / overflow); discuss production concerns (null handling, input validation, thread safety) when relevant.
