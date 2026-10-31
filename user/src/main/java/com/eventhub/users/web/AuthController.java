package com.eventhub.users.web;

import com.eventhub.users.security.TokenService;
import com.eventhub.users.user.User;
import com.eventhub.users.user.UserService;
import com.eventhub.users.web.dto.LoginRequest;
import com.eventhub.users.web.dto.LoginResponse;
import com.eventhub.users.web.dto.RegisterRequest;
import com.eventhub.users.web.dto.UserProfile;
import com.eventhub.users.web.dto.UserSummary;

import jakarta.validation.Valid;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/** Endpoints públicos: cadastro e login. */
@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    private final UserService users;
    private final TokenService tokens;

    public AuthController(UserService users, TokenService tokens) {
        this.users = users;
        this.tokens = tokens;
    }

    @PostMapping("/register")
    @ResponseStatus(HttpStatus.CREATED)
    public UserProfile register(@Valid @RequestBody RegisterRequest request) {
        return UserProfile.from(users.register(request.name(), request.email(), request.password()));
    }

    @PostMapping("/login")
    public LoginResponse login(@Valid @RequestBody LoginRequest request) {
        User user = users.authenticate(request.email(), request.password());
        TokenService.IssuedToken token = tokens.issue(user);
        return LoginResponse.bearer(token.value(), token.expiresInSeconds(), UserSummary.from(user));
    }
}
