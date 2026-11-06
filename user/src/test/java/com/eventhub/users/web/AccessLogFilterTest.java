package com.eventhub.users.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import jakarta.servlet.FilterChain;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

class AccessLogFilterTest {

    private static final String LINE = "^(\\S+) (\\S+) status=(\\d{3}) duration=\\d+ms user=(\\S+) trace_id=(\\S+)$";

    private final TraceIdFilter trace = new TraceIdFilter();
    private final AccessLogFilter access = new AccessLogFilter();
    private final AccessLogSubjectFilter subject = new AccessLogSubjectFilter();
    private final Logger logger = (Logger) LoggerFactory.getLogger(AccessLogFilter.LOGGER_NAME);
    private ListAppender<ILoggingEvent> appender;
    private Level previous;

    @BeforeEach
    void attach() {
        previous = logger.getLevel();
        logger.setLevel(Level.INFO);
        appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
    }

    @AfterEach
    void detach() {
        logger.detachAppender(appender);
        logger.setLevel(previous);
        SecurityContextHolder.clearContext();
    }

    /** Executa TraceIdFilter -> AccessLogFilter -> (corpo) como na ordem real; devolve a resposta. */
    private MockHttpServletResponse run(MockHttpServletRequest req, FilterChain body) throws Exception {
        MockHttpServletResponse res = new MockHttpServletResponse();
        trace.doFilter(req, res, (r, s) -> access.doFilter(r, s, body));
        return res;
    }

    private static MockHttpServletRequest request(String method, String uri) {
        MockHttpServletRequest req = new MockHttpServletRequest(method, uri);
        req.setRequestURI(uri);
        return req;
    }

    private List<String> lines() {
        return appender.list.stream().map(ILoggingEvent::getFormattedMessage).toList();
    }

    private static JwtAuthenticationToken authWithSub(String sub) {
        Jwt jwt = Jwt.withTokenValue("t").header("alg", "RS256").subject(sub)
                .issuedAt(Instant.now()).expiresAt(Instant.now().plusSeconds(60)).build();
        return new JwtAuthenticationToken(jwt, List.of(new SimpleGrantedAuthority("ROLE_PARTICIPANT")));
    }

    @Test
    void logsOneLineInPlatformFormatWithTraceIdFromResponseHeader() throws Exception {
        MockHttpServletRequest req = request("POST", "/api/v1/auth/login");
        req.addHeader("X-Trace-Id", "abc12345-req.1");
        MockHttpServletResponse res = run(req, (r, s) -> ((MockHttpServletResponse) s).setStatus(200));

        assertThat(lines()).hasSize(1);
        assertThat(lines().get(0)).matches(LINE);
        assertThat(lines().get(0)).startsWith("POST /api/v1/auth/login status=200 duration=")
                .endsWith(" user=- trace_id=abc12345-req.1");
        assertThat(res.getHeader("X-Trace-Id")).isEqualTo("abc12345-req.1");
        assertThat(appender.list.get(0).getLevel()).isEqualTo(Level.INFO);
    }

    @Test
    void generatedTraceIdMatchesResponseHeader() throws Exception {
        MockHttpServletResponse res = run(request("GET", "/x/long-path"), (r, s) -> { });
        assertThat(lines().get(0)).endsWith("trace_id=" + res.getHeader("X-Trace-Id"));
    }

    @Test
    void logsFinalStatusOf404And401() throws Exception {
        run(request("GET", "/nope/path"), (r, s) -> ((MockHttpServletResponse) s).setStatus(404));
        run(request("GET", "/api/v1/users/me"), (r, s) -> ((MockHttpServletResponse) s).setStatus(401));
        assertThat(lines().get(0)).contains("GET /nope/path status=404");
        assertThat(lines().get(1)).contains("GET /api/v1/users/me status=401 ").contains("user=-");
    }

    @Test
    void logsStatus500WhenChainThrowsAndRethrows() {
        assertThatThrownBy(() -> run(request("GET", "/boom/path"), (r, s) -> {
            throw new IllegalStateException("x");
        })).isInstanceOf(IllegalStateException.class);
        assertThat(lines()).hasSize(1);
        assertThat(lines().get(0)).contains("GET /boom/path status=500 ");
    }

    @Test
    void neverLogsQueryStringOrAuthorization() throws Exception {
        MockHttpServletRequest req = request("GET", "/api/v1/users");
        req.setQueryString("email=ana@example.com&name=Ana");
        req.addParameter("email", "ana@example.com");
        req.addHeader("Authorization", "Bearer secret.jwt.token");
        req.setContent("{\"password\":\"hunter2\"}".getBytes());
        run(req, (r, s) -> { });
        String line = lines().get(0);
        assertThat(line).startsWith("GET /api/v1/users status=200 ");
        assertThat(line).doesNotContain("ana", "email", "?", "Bearer", "secret", "hunter2", "Authorization");
    }

    @Test
    void userIsSubWhenAuthenticatedEvenAfterContextIsCleared() throws Exception {
        String sub = UUID.randomUUID().toString();
        run(request("GET", "/api/v1/users/me"), (r, s) -> {
            SecurityContextHolder.getContext().setAuthentication(authWithSub(sub));
            try {
                subject.doFilter(r, s, (r2, s2) -> { });
            } finally {
                SecurityContextHolder.clearContext(); // como o filtro de segurança faz ao terminar
            }
        });
        assertThat(lines().get(0)).contains(" user=" + sub + " ");
    }

    @Test
    void userIsDashWhenUnauthenticated() throws Exception {
        run(request("GET", "/api/v1/users/me"), (r, s) -> subject.doFilter(r, s, (r2, s2) -> { }));
        assertThat(lines().get(0)).contains(" user=- ");
    }

    @Test
    void forgedSubjectIsNeutralised() throws Exception {
        for (String bad : new String[] { "admin", "abc\r\nINFO forged line", UUID.randomUUID() + "\n" }) {
            appender.list.clear();
            run(request("GET", "/api/v1/users/me"), (r, s) -> {
                SecurityContextHolder.getContext().setAuthentication(authWithSub(bad));
                subject.doFilter(r, s, (r2, s2) -> { });
            });
            assertThat(lines()).hasSize(1);
            assertThat(lines().get(0)).matches(LINE).contains(" user=- ");
        }
    }

    @Test
    void controlCharactersInPathAreNeutralised() throws Exception {
        run(request("GET", "/a\r\nb/\u0000c"), (r, s) -> { });
        assertThat(lines().get(0)).matches(LINE).doesNotContain("\r", "\n", "\u0000");
    }

    @Test
    void healthchecksAreNotLogged() throws Exception {
        for (String path : new String[] { "/healthcheck", "/actuator/health", "/actuator/health/liveness" }) {
            run(request("GET", path), (r, s) -> { });
        }
        assertThat(lines()).isEmpty();
        run(request("GET", "/healthcheck-other"), (r, s) -> { });
        assertThat(lines()).hasSize(1);
    }
}
