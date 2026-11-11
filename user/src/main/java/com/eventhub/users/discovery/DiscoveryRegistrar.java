package com.eventhub.users.discovery;

import java.io.IOException;

import com.eventhub.users.config.UsersProperties;
import com.microservices.discovery.Kind;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * Registra esta instância no service-discoverer como kind {@code user} (contrato aprovado, DT-03).
 *
 * <p>Roda em thread própria: o serviço atende requisições mesmo com o discoverer fora do ar (RQ03). O registro é
 * repetido periodicamente porque o registry do discoverer é em memória e remove instâncias que ficam sem saúde
 * por algum tempo (ex.: banco indisponível); {@code register} é idempotente.
 */
@Component
@ConditionalOnProperty(name = "users.discovery.enabled", havingValue = "true")
class DiscoveryRegistrar {

    private static final Logger LOG = LoggerFactory.getLogger(DiscoveryRegistrar.class);

    private final long intervalMillis;

    DiscoveryRegistrar(UsersProperties props) {
        this.intervalMillis = props.discovery().reregisterSeconds() * 1000L;
    }

    @EventListener(ApplicationReadyEvent.class)
    void start() {
        Thread t = new Thread(this::loop, "discovery-register");
        t.setDaemon(true);
        t.start();
    }

    private void loop() {
        boolean registeredOnce = false;
        while (!Thread.currentThread().isInterrupted()) {
            try {
                // A lib faz até 10 tentativas com backoff e só então lança exceção.
                com.microservices.discovery.Discovery.register(Kind.USER);
                if (!registeredOnce) {
                    LOG.info("Registered in the service-discoverer as kind 'user'");
                    registeredOnce = true;
                }
            } catch (IOException e) {
                LOG.warn("Could not register in the service-discoverer ({}); will retry", e.getMessage());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
            try {
                Thread.sleep(intervalMillis);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }
}
