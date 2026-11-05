package com.eventhub.users.web;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.concurrent.atomic.AtomicReference;

import org.junit.jupiter.api.Test;
import org.slf4j.MDC;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class TraceIdFilterTest {

    private final TraceIdFilter filter = new TraceIdFilter();

    private String run(String incoming, AtomicReference<String> mdcInside) throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest();
        if (incoming != null) {
            req.addHeader(TraceIdFilter.HEADER, incoming);
        }
        MockHttpServletResponse res = new MockHttpServletResponse();
        filter.doFilter(req, res, (r, s) -> mdcInside.set(MDC.get(TraceIdFilter.MDC_KEY)));
        assertThat(MDC.get(TraceIdFilter.MDC_KEY)).isNull(); // limpo após a requisição
        return res.getHeader(TraceIdFilter.HEADER);
    }

    @Test
    void keepsSafeIncomingId() throws Exception {
        AtomicReference<String> inside = new AtomicReference<>();
        assertThat(run("abc12345-req.1", inside)).isEqualTo("abc12345-req.1");
        assertThat(inside.get()).isEqualTo("abc12345-req.1");
    }

    @Test
    void replacesUnsafeOrMissingId() throws Exception {
        for (String bad : new String[] { "curto", "tem espaco no meio", "x".repeat(65), "id\r\nX-Evil: 1", null }) {
            AtomicReference<String> inside = new AtomicReference<>();
            String out = run(bad, inside);
            assertThat(out).matches("[0-9a-f-]{36}").isNotEqualTo(bad);
            assertThat(inside.get()).isEqualTo(out);
        }
    }
}
