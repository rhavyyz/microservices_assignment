package com.eventhub.users.logging;

import java.net.UnknownHostException;
import java.util.Map;

import com.microservices.discovery.Discovery;

import org.springframework.boot.EnvironmentPostProcessor;
import org.springframework.boot.SpringApplication;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;

/**
 * Publica {@code users.instance-id} antes de o logging ser inicializado, para que o padrão de log e o JSON
 * estruturado (application.yml) o usem em toda linha, de qualquer thread.
 *
 * <p>O valor é exatamente o host que esta instância registra no service-discoverer ({@code SERVICE_HOST}, ou
 * {@code <hostname>:<PORT ou 8080>}), calculado pela mesma regra da lib de discovery.
 */
public class InstanceIdPostProcessor implements EnvironmentPostProcessor {

    public static final String PROPERTY = "users.instance-id";
    static final String SOURCE_NAME = "usersInstanceId";

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        environment.getPropertySources().addLast(new MapPropertySource(SOURCE_NAME, Map.of(PROPERTY, instanceId())));
    }

    static String instanceId() {
        try {
            return Discovery.selfHost();
        } catch (UnknownHostException e) {
            return "unknown";
        }
    }
}
