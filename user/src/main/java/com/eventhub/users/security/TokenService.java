package com.eventhub.users.security;

import java.time.Clock;
import java.time.Instant;
import java.util.UUID;

import com.eventhub.users.config.UsersProperties;
import com.eventhub.users.user.Role;
import com.eventhub.users.user.User;

import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.stereotype.Service;

/**
 * Emite o Access Token. Claims: {@code sub} (UUID), {@code roles}, {@code iss}, {@code iat}, {@code exp}, {@code jti}.
 * Nenhum dado de perfil, senha ou hash entra no token.
 */
@Service
public class TokenService {

    public record IssuedToken(String value, long expiresInSeconds) {
    }

    private final JwtEncoder encoder;
    private final UsersProperties.Jwt config;
    private final Clock clock;

    public TokenService(JwtEncoder encoder, UsersProperties props, Clock clock) {
        this.encoder = encoder;
        this.config = props.jwt();
        this.clock = clock;
    }

    public IssuedToken issue(User user) {
        Instant now = clock.instant();
        JwtClaimsSet claims = JwtClaimsSet.builder()
                .issuer(config.issuer())
                .subject(user.getId().toString())
                .issuedAt(now)
                .expiresAt(now.plusSeconds(config.ttlSeconds()))
                .id(UUID.randomUUID().toString())
                .claim("roles", user.getRoles().stream().map(Role::name).sorted().toList())
                .build();
        JwsHeader header = JwsHeader.with(SignatureAlgorithm.RS256).keyId(config.keyId()).build();
        String token = encoder.encode(JwtEncoderParameters.from(header, claims)).getTokenValue();
        return new IssuedToken(token, config.ttlSeconds());
    }
}
