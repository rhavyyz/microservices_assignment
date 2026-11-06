package com.eventhub.users.logging;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.InetAddress;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.encoder.PatternLayoutEncoder;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.LoggingEvent;
import ch.qos.logback.classic.Level;

import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.core.env.PropertySource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.mock.env.MockEnvironment;

class InstanceIdTest {

    private static String hostName() throws Exception {
        return InetAddress.getLocalHost().getHostName();
    }

    @Test
    void postProcessorPublishesTheDiscoveryHostRuleAsProperty() throws Exception {
        MockEnvironment env = new MockEnvironment();
        new InstanceIdPostProcessor().postProcessEnvironment(env, new SpringApplication());
        String id = env.getProperty(InstanceIdPostProcessor.PROPERTY);
        // sem SERVICE_HOST/PORT no ambiente de teste a regra dá <hostname>:8080; com eles, vale o que eles ditam
        String serviceHost = System.getenv("SERVICE_HOST");
        String port = System.getenv("PORT");
        String expected = serviceHost != null && !serviceHost.isEmpty() ? serviceHost
                : hostName() + ":" + (port == null || port.isEmpty() ? "8080" : port);
        assertThat(id).isEqualTo(expected);
    }

    @Test
    void configuredConsolePatternPutsTheInstanceRightAfterTheLevel() throws Exception {
        PropertySource<?> yml = new YamlPropertySourceLoader()
                .load("application", new ClassPathResource("application.yml")).get(0);
        String raw = (String) yml.getProperty("logging.pattern.console");
        assertThat(raw).contains("%-5level instance=${users.instance-id} [");
        assertThat(yml.getProperty("logging.structured.json.add.instance")).isEqualTo("${users.instance-id}");

        MockEnvironment env = new MockEnvironment();
        new InstanceIdPostProcessor().postProcessEnvironment(env, new SpringApplication());
        String pattern = env.resolvePlaceholders(raw);

        LoggerContext ctx = new LoggerContext();
        ctx.setMDCAdapter(new ch.qos.logback.classic.util.LogbackMDCAdapter());
        PatternLayoutEncoder enc = new PatternLayoutEncoder();
        enc.setContext(ctx);
        enc.setPattern(pattern);
        enc.start();
        Logger logger = ctx.getLogger("com.eventhub.users.access");
        ILoggingEvent event = new LoggingEvent(Logger.class.getName(), logger, Level.INFO, "GET /x status=200", null, null);
        String line = new String(enc.encode(event));

        String id = env.getProperty(InstanceIdPostProcessor.PROPERTY);
        assertThat(line).containsPattern("INFO  instance=" + java.util.regex.Pattern.quote(id) + " \\[\\] c\\.eventhub");
        assertThat(line.split("instance=", -1)).hasSize(2);
    }
}
