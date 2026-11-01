package com.eventhub.users.security;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.interfaces.RSAPrivateCrtKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Base64;

/** Leitura da chave de assinatura (PEM PKCS#8). As mensagens de erro nunca reproduzem o conteúdo da chave. */
final class PemKeys {

    private static final int MIN_RSA_BITS = 2048;

    private PemKeys() {
    }

    static RSAPrivateCrtKey readRsaPrivateKey(Path file) {
        String pem;
        try {
            pem = Files.readString(file, StandardCharsets.US_ASCII);
        } catch (NoSuchFileException e) {
            throw new IllegalStateException("Chave privada JWT não encontrada em '" + file
                    + "'. Em desenvolvimento, gere-a com user/scripts/gen-dev-keys.sh; em outros ambientes, monte-a como segredo.");
        } catch (IOException e) {
            throw new IllegalStateException("Não foi possível ler a chave privada JWT em '" + file + "'.");
        }
        if (pem.contains("BEGIN RSA PRIVATE KEY")) {
            throw new IllegalStateException(
                    "A chave privada JWT está em PKCS#1. Converta para PKCS#8 (openssl pkcs8 -topk8 -nocrypt).");
        }
        String base64 = pem
                .replace("-----BEGIN PRIVATE KEY-----", "")
                .replace("-----END PRIVATE KEY-----", "")
                .replaceAll("\\s", "");
        try {
            var key = KeyFactory.getInstance("RSA")
                    .generatePrivate(new PKCS8EncodedKeySpec(Base64.getDecoder().decode(base64)));
            if (!(key instanceof RSAPrivateCrtKey crt)) {
                throw new IllegalStateException("A chave privada JWT deve ser RSA com parâmetros CRT.");
            }
            if (crt.getModulus().bitLength() < MIN_RSA_BITS) {
                throw new IllegalStateException("A chave privada JWT deve ter pelo menos " + MIN_RSA_BITS + " bits.");
            }
            return crt;
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            throw new IllegalStateException("A chave privada JWT em '" + file + "' não é um PEM PKCS#8 RSA válido.");
        }
    }
}
