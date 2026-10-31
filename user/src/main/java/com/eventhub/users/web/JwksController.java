package com.eventhub.users.web;

import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;

import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** Publica somente a chave pública (JWKS, RFC 7517) para que os demais serviços validem os tokens. */
@RestController
public class JwksController {

    private final String publicJwks;

    public JwksController(RSAKey signingKey) {
        // toPublicJWK() remove o material privado; JWKSet#toString() também serializa apenas chaves públicas.
        this.publicJwks = new JWKSet(signingKey.toPublicJWK()).toString();
    }

    @GetMapping(value = "/.well-known/jwks.json", produces = MediaType.APPLICATION_JSON_VALUE)
    public String jwks() {
        return publicJwks;
    }
}
