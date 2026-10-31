package com.eventhub.users.security;

import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.interfaces.RSAPrivateCrtKey;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.RSAPublicKeySpec;

import com.eventhub.users.config.UsersProperties;
import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.KeyUse;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.source.ImmutableJWKSet;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;

/**
 * Chaves e codec de JWT (ADR-001): RS256 com chave privada injetada por arquivo. A mesma chave em todas as
 * réplicas faz com que um token emitido por uma instância seja aceito pelas outras.
 */
@Configuration
public class JwtConfig {

    @Bean
    RSAKey signingKey(UsersProperties props) {
        UsersProperties.Jwt jwt = props.jwt();
        RSAPrivateCrtKey priv = PemKeys.readRsaPrivateKey(Path.of(jwt.privateKeyFile()));
        try {
            RSAPublicKey pub = (RSAPublicKey) KeyFactory.getInstance("RSA")
                    .generatePublic(new RSAPublicKeySpec(priv.getModulus(), priv.getPublicExponent()));
            return new RSAKey.Builder(pub)
                    .privateKey(priv)
                    .keyID(jwt.keyId())
                    .keyUse(KeyUse.SIGNATURE)
                    .algorithm(JWSAlgorithm.RS256)
                    .build();
        } catch (java.security.GeneralSecurityException e) {
            throw new IllegalStateException("Não foi possível derivar a chave pública JWT.", e);
        }
    }

    @Bean
    JwtEncoder jwtEncoder(RSAKey signingKey) {
        return new NimbusJwtEncoder(new ImmutableJWKSet<>(new JWKSet(signingKey)));
    }

    /** Valida assinatura (somente RS256), expiração e emissor. Tokens {@code alg=none} ou de outro emissor são recusados. */
    @Bean
    JwtDecoder jwtDecoder(RSAKey signingKey, UsersProperties props) {
        try {
            NimbusJwtDecoder decoder = NimbusJwtDecoder.withPublicKey(signingKey.toRSAPublicKey())
                    .signatureAlgorithm(SignatureAlgorithm.RS256)
                    .build();
            decoder.setJwtValidator(JwtValidators.createDefaultWithIssuer(props.jwt().issuer()));
            return decoder;
        } catch (JOSEException e) {
            throw new IllegalStateException("Chave pública JWT inválida.", e);
        }
    }
}
