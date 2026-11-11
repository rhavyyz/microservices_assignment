package com.eventhub.users.security;

import com.eventhub.users.config.UsersProperties;
import com.eventhub.users.web.AccessLogSubjectFilter;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter;
import org.springframework.security.oauth2.server.resource.authentication.JwtGrantedAuthoritiesConverter;
import org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter;
import org.springframework.security.web.SecurityFilterChain;

/**
 * API stateless protegida por Bearer Token (JWT). Sem sessão e sem cookies, logo CSRF não se aplica.
 * CORS não é configurado aqui: o Gateway responde preflights e define os cabeçalhos CORS (ADR-003).
 */
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    PasswordEncoder passwordEncoder(UsersProperties props) {
        return new BCryptPasswordEncoder(props.password().bcryptStrength());
    }

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http, ProblemAuthenticationEntryPoint entryPoint,
            ProblemAccessDeniedHandler accessDeniedHandler) throws Exception {
        http
                .addFilterAfter(new AccessLogSubjectFilter(), BearerTokenAuthenticationFilter.class)
                .csrf(csrf -> csrf.disable())
                .cors(cors -> cors.disable())
                .httpBasic(basic -> basic.disable())
                .formLogin(form -> form.disable())
                .logout(logout -> logout.disable())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .exceptionHandling(e -> e
                        .authenticationEntryPoint(entryPoint)
                        .accessDeniedHandler(accessDeniedHandler))
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers(HttpMethod.POST, "/api/v1/auth/register", "/api/v1/auth/login").permitAll()
                        .requestMatchers(HttpMethod.GET, "/.well-known/jwks.json", "/healthcheck", "/openapi.json")
                        .permitAll()
                        .requestMatchers("/error").permitAll()
                        // Consulta interna de nome (somente id e name) para outros serviços sem token de usuário.
                        // É protegida por isolamento de rede, não por token: o Gateway nunca deve expô-la.
                        .requestMatchers(HttpMethod.GET, "/internal/users/*").permitAll()
                        // Busca de usuários: dados pessoais de terceiros, somente organizadores (o serviço
                        // confere o papel no banco de novo, para que um rebaixamento valha antes de o token expirar).
                        .requestMatchers(HttpMethod.GET, "/api/v1/users").hasRole("ORGANIZER")
                        // Área do administrador: papel ADMIN no token e, de novo, no banco (UserService).
                        .requestMatchers("/api/v1/admin/**").hasRole("ADMIN")
                        .anyRequest().authenticated())
                .oauth2ResourceServer(oauth -> oauth
                        .authenticationEntryPoint(entryPoint)
                        .accessDeniedHandler(accessDeniedHandler)
                        .jwt(jwt -> jwt.jwtAuthenticationConverter(jwtAuthenticationConverter())));
        return http.build();
    }

    /** Converte a claim {@code roles} em autoridades {@code ROLE_*}; o principal é o {@code sub}. */
    private static JwtAuthenticationConverter jwtAuthenticationConverter() {
        JwtGrantedAuthoritiesConverter authorities = new JwtGrantedAuthoritiesConverter();
        authorities.setAuthoritiesClaimName("roles");
        authorities.setAuthorityPrefix("ROLE_");
        JwtAuthenticationConverter converter = new JwtAuthenticationConverter();
        converter.setJwtGrantedAuthoritiesConverter(authorities);
        return converter;
    }
}
