package com.eventhub.users.support;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.util.Base64;

import com.eventhub.users.config.UsersProperties;

/** Chaves e propriedades de teste. Chaves são geradas em tempo de execução: nada de segredo versionado. */
public final class TestKeys {

    private TestKeys() {
    }

    public static KeyPair generate(int bits) {
        try {
            KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
            g.initialize(bits);
            return g.generateKeyPair();
        } catch (java.security.GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    public static Path writePem(Path file, KeyPair pair) throws IOException {
        String body = Base64.getMimeEncoder(64, "\n".getBytes(StandardCharsets.US_ASCII))
                .encodeToString(pair.getPrivate().getEncoded());
        Files.writeString(file, "-----BEGIN PRIVATE KEY-----\n" + body + "\n-----END PRIVATE KEY-----\n");
        return file;
    }

    public static UsersProperties props(String issuer, long ttlSeconds, Path privateKeyFile) {
        return new UsersProperties(
                new UsersProperties.Jwt(issuer, "kid-test", privateKeyFile.toString(), ttlSeconds),
                new UsersProperties.Password(4),
                new UsersProperties.DevSeed(false, null, null, null),
                new UsersProperties.Discovery(false, 30));
    }
}
