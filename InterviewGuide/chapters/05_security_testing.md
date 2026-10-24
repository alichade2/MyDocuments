# Part 11 — Spring Security and Testing

## 11.1 Authentication vs authorization

* **Authentication (AuthN):** *Who are you?* (login, token). **Authorization (AuthZ):** *What may you do?* (roles, permissions). Failed AuthN → **401**; failed AuthZ → **403**.
* **Role-based access control (RBAC):** `ROLE_ADMIN`, `ROLE_DOCTOR`. **Authority-based:** finer permissions like `appointment:cancel`. Roles are coarse groups; authorities are specific permissions (in Spring, `hasRole("ADMIN")` checks the authority `ROLE_ADMIN`).

## 11.2 Spring Security architecture

Security is a chain of **servlet filters** that runs *before* `DispatcherServlet`.

```text
Request -> DelegatingFilterProxy -> FilterChainProxy -> SecurityFilterChain
   [CORS] [CSRF] [Your JwtAuthenticationFilter / BearerTokenAuthenticationFilter]
   [UsernamePasswordAuthenticationFilter] [ExceptionTranslationFilter] [AuthorizationFilter]
 -> Controller
Authentication flow: Filter builds an Authentication token -> AuthenticationManager
   -> AuthenticationProvider (DaoAuthenticationProvider: UserDetailsService + PasswordEncoder)
   -> success: stored in SecurityContextHolder (thread-local) -> authorization checks
```

**Key types:** `SecurityFilterChain`, `AuthenticationManager`, `UserDetailsService`, `PasswordEncoder`, `GrantedAuthority`, `SecurityContext`.

## 11.3 Passwords

Never store plain text or fast hashes (MD5/SHA-1/plain SHA-256). Use an **adaptive, salted** hash: **BCrypt** (or Argon2/SCrypt/PBKDF2). `BCryptPasswordEncoder` embeds a random salt and a cost factor so you can increase the work over time. `DelegatingPasswordEncoder` stores an algorithm prefix (`{bcrypt}...`) for painless upgrades.

## 11.4 Sessions vs tokens; JWT

| | Session (cookie) | JWT (stateless token) |
|---|---|---|
| State | Server stores session | Token carries claims; server stores nothing |
| Scaling | Needs sticky sessions or shared store (Redis) | Easy horizontal scaling |
| Revocation | Easy (delete session) | Hard until expiry (use short TTL, denylist, rotation) |
| CSRF | Vulnerable (cookies are sent automatically) → CSRF protection | Not by default if sent in `Authorization` header |
| Best for | Server-rendered web apps | APIs, mobile, microservices |

**JWT structure:** `header.payload.signature`, each Base64URL encoded. Header = algorithm/type; payload = **claims** (`sub`, `exp`, `iat`, `iss`, `aud`, roles); signature = HMAC (HS256, shared secret) or RSA/ECDSA (RS256/ES256, private key signs, public key verifies). **The payload is encoded, not encrypted — never put secrets in it.** Validate signature, `exp`, `iss`, `aud`; reject `alg=none`; pin the expected algorithm.

**Access vs refresh tokens:** a short-lived **access token** (minutes) is sent with each API call; a longer-lived **refresh token** gets new access tokens. Use **refresh-token rotation** (issue a new refresh token on every use and invalidate the old one; reuse of an old one signals theft → revoke the family). Store refresh tokens server-side (hashed) so they can be revoked. For browsers, prefer `HttpOnly; Secure; SameSite` cookies over `localStorage` (XSS can steal `localStorage`).

## 11.5 OAuth 2.0 and OpenID Connect

* **OAuth 2.0** is an *authorization* framework: a client gets a **limited access token** to a resource on a user's behalf without seeing the password. Roles: resource owner, client, authorization server, resource server. Use the **Authorization Code flow with PKCE** for web/mobile; **Client Credentials** for service-to-service. Implicit and Resource Owner Password flows are discouraged/deprecated.
* **OpenID Connect (OIDC)** adds an **identity layer** on OAuth 2.0: an **ID token** (a JWT) says who the user is.
* **OAuth 2.0 vs JWT:** OAuth is a *protocol*; JWT is a *token format*. OAuth access tokens may be JWTs or opaque strings.
* Typical setup: Keycloak/Auth0/Okta/Cognito as the authorization server; your Spring Boot service is a **resource server** validating JWTs with `spring-boot-starter-oauth2-resource-server`.

## 11.6 CORS vs CSRF

* **CORS:** browser mechanism letting a page from origin A call your API on origin B. It *relaxes* the same-origin policy; the **server** declares allowed origins/methods/headers.
* **CSRF:** an attacker's site makes the victim's browser send an authenticated request using the victim's cookies. Defence: CSRF tokens, `SameSite` cookies. For a stateless API using `Authorization: Bearer` headers (not cookies), CSRF protection can be disabled safely; **if you use cookie auth, keep it enabled.**

## 11.7 A practical JWT flow (Spring Boot 3 / Spring Security 6)

**Option A (recommended when you have an identity provider): resource server**

```java
@Configuration
@EnableMethodSecurity                       // enables @PreAuthorize
public class SecurityConfig {

    @Bean
    SecurityFilterChain api(HttpSecurity http) throws Exception {
        http
          .csrf(csrf -> csrf.disable())                                          // stateless bearer-token API
          .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
          .cors(Customizer.withDefaults())
          .authorizeHttpRequests(a -> a
              .requestMatchers("/actuator/health/**", "/api/v1/auth/**").permitAll()
              .requestMatchers(HttpMethod.GET, "/api/v1/products/**").hasAnyRole("USER", "ADMIN")
              .requestMatchers("/api/v1/admin/**").hasRole("ADMIN")
              .anyRequest().authenticated())
          .oauth2ResourceServer(o -> o.jwt(j -> j.jwtAuthenticationConverter(converter())));
        return http.build();
    }

    @Bean
    JwtAuthenticationConverter converter() {
        JwtGrantedAuthoritiesConverter g = new JwtGrantedAuthoritiesConverter();
        g.setAuthoritiesClaimName("roles");
        g.setAuthorityPrefix("ROLE_");
        JwtAuthenticationConverter c = new JwtAuthenticationConverter();
        c.setJwtGrantedAuthoritiesConverter(g);
        return c;
    }

    @Bean PasswordEncoder passwordEncoder() { return new BCryptPasswordEncoder(); }
}
// application.yml: spring.security.oauth2.resourceserver.jwt.issuer-uri: https://idp.example.com/realms/shop
```

**Option B: your own login endpoint issues the JWT (for self-contained apps)**

Flow:
1. `POST /api/v1/auth/login {email, password}` → `AuthenticationManager.authenticate(...)` verifies the BCrypt hash via your `UserDetailsService`.
2. On success a service builds a signed JWT (for example with `NimbusJwtEncoder`, jjwt, or Nimbus library): `sub=userId`, `roles`, `exp=now+15min`, `iss`. Also create and store a hashed **refresh token**.
3. The client sends `Authorization: Bearer <token>` on each request.
4. A `JwtDecoder` bean (or a custom `OncePerRequestFilter`) validates signature and expiry, and builds the `Authentication` placed in the `SecurityContext`.
5. `authorizeHttpRequests` and `@PreAuthorize("hasRole('ADMIN') or #userId == authentication.name")` enforce access.
6. On expiry the client calls `/auth/refresh`; the server rotates the refresh token.
7. Logout deletes the refresh token (and optionally denylists the access token's `jti` until it expires).

```java
@RestController @RequestMapping("/api/v1/auth")
class AuthController {
    private final AuthenticationManager manager; private final TokenService tokens;
    AuthController(AuthenticationManager m, TokenService t) { this.manager = m; this.tokens = t; }

    @PostMapping("/login")
    TokenResponse login(@Valid @RequestBody LoginRequest r) {
        Authentication a = manager.authenticate(new UsernamePasswordAuthenticationToken(r.email(), r.password()));
        return tokens.issue(a);                 // access + refresh
    }
}
```

**Method-level security:** `@PreAuthorize("hasAuthority('appointment:cancel')")` (needs `@EnableMethodSecurity`). Use it for **ownership checks** ("only the patient can cancel their own appointment") that URL rules cannot express.

**Obsolete style to recognize in legacy code:** `class SecurityConfig extends WebSecurityConfigurerAdapter` with `configure(HttpSecurity)`, `antMatchers`, `.and()` chains. Removed in Spring Security 6; migrate to a `SecurityFilterChain` bean with the lambda DSL and `requestMatchers`.

## 11.8 Common vulnerabilities and secure practices

* **Broken access control / IDOR:** `GET /orders/42` returns someone else's order. Always check ownership server-side.
* **Mass assignment:** binding request JSON directly to entities (`role` field set by attacker) → use DTOs.
* **SQL injection:** never concatenate input; use parameterized queries/JPA parameters.
* **XSS, CSRF, SSRF, insecure deserialization, secrets in code, verbose errors** leaking stack traces.
* **Brute force:** rate limit login, lockout/backoff, MFA.
* **Transport:** HTTPS/TLS everywhere, HSTS; secure cookies.
* **Secrets:** environment variables or a vault (HashiCorp Vault, AWS Secrets Manager, Kubernetes Secrets with encryption); rotate regularly; use short-lived credentials; never log them; scan repositories (git-secrets, gitleaks).
* **Dependencies:** scan with OWASP Dependency-Check / Dependabot / Snyk; keep Spring patched.
* **Error handling:** generic messages to clients ("Invalid credentials" for both unknown user and wrong password), details in logs.

---

## 11.9 Spring Boot testing

**Unit vs integration tests:**

| | Unit | Integration |
|---|---|---|
| Scope | One class, dependencies mocked | Several real components (Spring context, DB, HTTP) |
| Speed | Milliseconds | Seconds |
| Tools | JUnit 5 + Mockito | `@SpringBootTest`, `@DataJpaTest`, Testcontainers |
| Find | Logic bugs | Wiring, SQL, serialization, config bugs |

Follow the **test pyramid**: many unit tests, fewer slice/integration tests, very few end-to-end tests.

**Mockito:** `@Mock` creates a mock; `@InjectMocks` builds the class under test and injects mocks; a **Spy** wraps a *real* object so you can stub some methods (partial mock) while the rest run for real. In Spring tests, `@MockBean` (Boot ≤ 3.3) replaced a bean in the context; from Boot 3.4 use `@MockitoBean` (Spring Framework 6.2) — `@MockBean` is deprecated in newer versions. Check the Boot version you use.

**Service unit test**

```java
@ExtendWith(MockitoExtension.class)
class ProductServiceTest {
    @Mock ProductRepository repo;
    @Spy  ProductMapper mapper = new ProductMapper();
    @InjectMocks ProductService service;

    @Test void get_returnsProduct() {
        Product p = new Product("Pen", new BigDecimal("2.50"));
        when(repo.findById(1L)).thenReturn(Optional.of(p));

        ProductResponse r = service.get(1L);

        assertThat(r.name()).isEqualTo("Pen");
        verify(repo).findById(1L);
    }

    @Test void get_whenMissing_throws() {
        when(repo.findById(9L)).thenReturn(Optional.empty());
        assertThatThrownBy(() -> service.get(9L)).isInstanceOf(ResourceNotFoundException.class);
    }
}
```

**Controller slice test with MockMvc**

```java
@WebMvcTest(ProductController.class)       // loads only the web layer, not services/repos
class ProductControllerTest {
    @Autowired MockMvc mvc;
    @MockBean ProductService service;      // use @MockitoBean on newer Boot
    @Autowired ObjectMapper om;

    @Test @WithMockUser(roles = "ADMIN")
    void create_returns201() throws Exception {
        when(service.create(any())).thenReturn(new ProductResponse(1L, "Pen", new BigDecimal("2.50")));
        mvc.perform(post("/api/v1/products").with(csrf())
                .contentType(MediaType.APPLICATION_JSON)
                .content(om.writeValueAsString(new ProductRequest("Pen", new BigDecimal("2.50")))))
           .andExpect(status().isCreated())
           .andExpect(header().exists("Location"))
           .andExpect(jsonPath("$.name").value("Pen"));
    }

    @Test @WithMockUser
    void create_invalid_returns400() throws Exception {
        mvc.perform(post("/api/v1/products").with(csrf()).contentType(MediaType.APPLICATION_JSON)
                .content("{\"name\":\"\",\"price\":-1}"))
           .andExpect(status().isBadRequest());
    }
}
```

**Repository test with a real database (Testcontainers)**

```java
@DataJpaTest                                                        // JPA slice, rolls back after each test
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE) // use the container, not embedded H2
@Testcontainers
class ProductRepositoryTest {
    @Container @ServiceConnection                                   // Boot 3.1+: auto-wires the datasource
    static PostgreSQLContainer<?> pg = new PostgreSQLContainer<>("postgres:16-alpine");

    @Autowired ProductRepository repo;

    @Test void findByName_isCaseInsensitive() {
        repo.save(new Product("Notebook", new BigDecimal("4.00")));
        Page<Product> page = repo.findByNameContainingIgnoreCase("note", PageRequest.of(0, 10));
        assertThat(page.getContent()).hasSize(1);
    }
}
```

**Full integration test:** `@SpringBootTest(webEnvironment = RANDOM_PORT)` + `TestRestTemplate`/`WebTestClient`/`RestAssured` + Testcontainers.

**Why Testcontainers instead of H2:** H2 behaves differently from your production database (SQL dialect, locking, JSON types, isolation), so tests can pass while production fails.

**Good testing habits:** name tests by behaviour (`transfer_failsWhenBalanceTooLow`); one reason to fail; avoid testing implementation details/over-verifying mocks (brittle); use builders/fixtures; no sleeping — use Awaitility for async; keep tests independent and deterministic (inject `Clock`); test exceptions and security paths; measure coverage but do not chase 100% — focus on business-critical logic and boundaries; test `@Transactional` behaviour with a real DB (test-managed transactions roll back by default, which can hide commit-time errors).
