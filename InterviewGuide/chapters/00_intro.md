# How to Use This Book

This handbook is written for a developer with about **8 years of experience** preparing for Senior Java Developer / Senior Software Engineer / Spring Boot roles. At this level, interviewers do not only ask *"what is X?"*. They ask **why** X exists, **how** it works inside, **what breaks** in production, and **what you would choose and why**.

## The study method

1. **Read the simple answer first.** Say it out loud in your own words.
2. **Read "Understand it"** until you could draw the idea on a whiteboard.
3. **Type the code yourself.** Do not copy and paste. Break it on purpose and see the error.
4. **Read "Common mistakes" and "Follow-ups".** Senior interviews are won on follow-ups.
5. **Finish with the "Interview-ready answer"** and practise it in 30–90 seconds.

## The standard structure of a deep question

| Section | Purpose |
|---|---|
| Question | The exact words an interviewer may use |
| Simple answer | A short spoken answer |
| Understand it | Step-by-step explanation from the basics |
| Real-life example | An analogy from e-commerce, banking, hospital, booking |
| Code + explanation | Working Java / Spring Boot code and why each part exists |
| Internals | What the JVM / Spring / Hibernate does under the hood |
| When to use, pros, cons | Trade-offs, not hype |
| Common mistakes | Traps interviewers like |
| Follow-ups | What comes next |
| Interview-ready answer | Your final 30–90 second answer |

Shorter topics use a compressed form of this structure. Comparison topics use tables.

## Honest notes about this book

* **Version labels.** Features are labelled with the Java / Spring version that introduced them. Code marked *Java 8* uses only Java 8 syntax.
* **No invented numbers.** This book does not quote benchmarks or "interview frequency" statistics. Where performance is discussed, it is described as relative behaviour (for example "O(1) average"), which you can verify yourself.
* **Verify versions before the interview.** Spring Boot, Spring Security and Hibernate move fast. Boot 3.x requires Java 17+ and the `jakarta.*` namespace. Check the latest stable release notes for anything newer than your preparation date; this book will tell you which parts are most likely to have changed.
* **Your own projects.** Behavioral chapters use placeholders such as `<YOUR PROJECT>`. Replace them with **your real experience**. Never claim work you did not do.

## What interviewers at 8 years evaluate

* **Depth:** can you explain internals, not just APIs?
* **Judgement:** can you pick between options and defend trade-offs?
* **Production sense:** have you debugged slow queries, memory leaks, deadlocks, bad deployments?
* **Design ability:** can you break a vague requirement into services, data, APIs and failure handling?
* **Ownership and leadership:** mentoring, code review, incidents, disagreement, delivery.

## Suggested 6-week plan

| Week | Focus |
|---|---|
| 1 | Java core, OOP, collections, exceptions |
| 2 | Java 8+, concurrency, JVM and GC |
| 3 | Spring core, Boot, MVC/REST, JPA, transactions |
| 4 | Security, testing, microservices, Kafka |
| 5 | SQL, coding problems (a few daily), design patterns |
| 6 | System design, production scenarios, behavioral, mock interviews |
