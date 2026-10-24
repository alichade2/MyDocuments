# Part 19 — Behavioral and Project-Based Questions

> **Important:** every example below is a *hypothetical template* with placeholders such as `<YOUR PROJECT>`. Replace them with **your real experience**. Interviewers can tell when stories are invented, and follow-ups will expose them. Use the **STAR+** structure: **S**ituation, **T**ask, **A**ction (what *you* did, "I" not "we"), **R**esult (measure it if you truly can), plus **L**earning.

## 19.1 What interviewers evaluate

| Theme | They want to see |
|---|---|
| Ownership | You drive outcomes beyond your ticket |
| Technical depth | You know *why*, not just *what* |
| Judgement | You weigh trade-offs and decide with incomplete data |
| Communication | You explain clearly to engineers and non-engineers |
| Leadership | You raise the team's level (reviews, mentoring) |
| Resilience | You stay calm in incidents and learn from failures |

## 19.2 Questions, intent, and answer structure

**1. "Explain your current project architecture."**
*Evaluates:* big-picture thinking, ability to communicate complexity, awareness of trade-offs. *Structure:* business purpose → users and scale → architecture diagram in words (clients, gateway, services, data stores, messaging) → your part → key decisions and why → known weaknesses and what you'd improve. See the full example in 19.3.

**2. "What is your role and ownership?"**
*Evaluates:* scope and seniority. *Structure:* "I am responsible for `<modules/services>`. I own design, delivery, production support and mentoring for `<area>`. Examples of decisions I own: `<…>`. I collaborate with `<product, QA, DevOps>`."

**3. "Describe a challenging production incident."**
*Evaluates:* composure, method, learning. *Template:* "In `<YOUR PROJECT>`, after a release we saw `<symptom, e.g., rising latency / 500s>`. I first checked what changed and the dashboards, mitigated by `<rollback/scale/feature flag>` to restore service, then used `<thread dump / heap dump / traces / slow query log>` to find the root cause: `<cause>`. We fixed it by `<fix>` and added `<alert/test/process change>` so it cannot recur. Impact: `<real, measured numbers only if you know them>`." Emphasize **mitigate first, root cause second, prevention third**, and a blameless review.

**4. "How did you improve application performance?"**
*Evaluates:* measuring before optimizing. *Structure:* baseline metrics → profiling/tracing to find the bottleneck → hypothesis → change (query/index, caching, N+1 fix, async, pool sizing) → re-measure → guard against regression (tests, dashboards). Never claim an improvement you did not measure.

**5. "How do you handle high traffic?"**
*Evaluates:* scalability knowledge. *Structure:* stateless services + horizontal scaling; caching (CDN, Redis); database (indexes, read replicas, partitioning); async processing/queues; back-pressure, rate limiting, timeouts, circuit breakers; autoscaling; load testing; observability. Add one concrete example from your experience if you have it.

**6. "How do you review code?"**
*Evaluates:* quality mindset and collaboration. *Structure:* understand the purpose first; check design and correctness, tests, error handling, security, performance risks, readability; separate **must-fix** from **suggestions**; ask questions instead of commanding; praise good work; keep PRs small; automate formatting/static checks.

**7. "How do you mentor junior developers?"**
*Evaluates:* leadership. *Structure:* pair programming on real tasks, explain the *why*, give progressively harder work, constructive reviews, create documentation/learning paths, encourage them to present, give space to make safe mistakes. Provide an example of someone you helped grow (real).

**8. "How do you handle disagreements in design decisions?"**
*Evaluates:* maturity. *Structure:* seek to understand the other view; move from opinions to **criteria and data** (requirements, risks, cost, prototypes/spike); document the options (an ADR — Architecture Decision Record); decide, or escalate when needed; **disagree and commit**; revisit if evidence changes.

**9. "Describe a difficult bug you solved."**
*Evaluates:* debugging method. *Template:* symptom → how you reproduced it → hypotheses eliminated → tools used → root cause (e.g., a race condition, a timezone issue, a lazy-loading problem, a connection leak) → fix → a test that would have caught it → what you learned.

**10. "How do you make technical decisions?"**
*Evaluates:* structured thinking. *Structure:* clarify requirements and constraints → list options → compare on criteria (fit, complexity, team skills, operability, cost, risk, reversibility) → prototype risky parts → decide and record it → review later. Mention preferring reversible decisions and boring technology when it fits.

**11. "How do you ensure code quality?"**
*Structure:* testing pyramid, code reviews, CI with static analysis and quality gates, coding standards, refactoring regularly, observability, definition of done, tracking and paying down technical debt deliberately.

**12. "How do you approach a legacy application?"**
*Structure:* learn first (read, run, observe production behaviour); add **characterization tests** around critical flows; add logging/metrics; refactor in small steps; apply the **strangler fig** pattern for large migrations (route features gradually to new code); do not rewrite everything at once; upgrade dependencies incrementally.

**13. "How do you handle tight deadlines?"**
*Structure:* clarify what is truly required (**scope negotiation**), prioritize by value and risk, break down work and expose risks early, deliver incrementally, keep quality gates for critical parts, communicate honestly with stakeholders, and record any shortcut as tracked tech debt. Avoid heroics as a strategy.

**14. "What would you improve in your current system?"**
*Evaluates:* honest critical thinking without blaming. *Structure:* pick a real weakness (e.g., missing observability, slow release process, test coverage on critical flows, tight coupling) → why it matters → how you'd approach it incrementally → expected benefit → how you'd measure success.

**15. "Why should we hire you as a senior developer?"**
*Structure:* a three-part pitch: (1) **technical depth** in Java/Spring and distributed systems backed by `<real achievements>`; (2) **ownership** — you deliver and run services in production; (3) **multiplier effect** — mentoring, reviews, raising standards. Tie it to the company's needs (research them first). Keep it under 90 seconds.

## 19.3 Example: explaining an end-to-end project architecture (template)

*Replace every placeholder with your real project. The shape is what matters.*

> "`<YOUR PROJECT>` is a `<type, e.g., appointment booking platform>` used by `<users>`. At its core we have `<N>` Spring Boot services behind an API gateway.
>
> **Request flow:** the client calls the gateway, which validates the JWT and routes to, for example, the Appointment Service. The controller validates the DTO, the service layer runs the use case inside a transaction, and the repository talks to `<PostgreSQL/MySQL>` through Spring Data JPA.
>
> **Database interaction:** each service owns its schema; migrations are managed with `<Flyway>`; we use `<optimistic locking / unique constraints>` to protect against concurrent updates; list endpoints use `<projections/pagination>` to avoid N+1.
>
> **Cross-service communication:** synchronous REST for queries with timeouts and circuit breakers; asynchronous events on `<Kafka/RabbitMQ>` for things like notifications, using the outbox pattern and idempotent consumers.
>
> **Exception handling:** a global `@RestControllerAdvice` returns a consistent error format with a correlation id; business errors map to 4xx, unexpected ones to 500 with details only in logs.
>
> **Security:** `<OAuth2/JWT>` with role and ownership checks; secrets from `<Vault/Kubernetes Secrets>`; HTTPS everywhere.
>
> **Deployment:** Docker images built in `<Jenkins/GitHub Actions>`, deployed to `<Kubernetes/ECS>` with rolling updates, readiness probes and graceful shutdown; config per environment.
>
> **Monitoring:** Micrometer metrics to `<Prometheus/Grafana>`, centralized JSON logs, distributed tracing, alerts on error rate and latency.
>
> **Challenges and what I'd improve:** `<a real challenge, e.g., double bookings under load, solved with …>`; next I'd like to `<improvement>`."

Practise this until it takes **3–4 minutes**, and be ready to zoom into any box on the diagram.

## 19.4 Answer-quality checklist

* Use "I" for what you personally did, "we" for team outcomes.
* Quantify only with numbers you actually know; otherwise describe impact qualitatively.
* Show trade-offs and what you would do differently.
* Keep stories 2–3 minutes; offer details if asked.
* Prepare 5–6 reusable stories: a production incident, a performance win, a conflict, a mentoring success, a failure you learned from, a large delivery under pressure.
