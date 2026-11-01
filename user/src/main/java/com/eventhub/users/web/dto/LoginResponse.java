package com.eventhub.users.web.dto;

public record LoginResponse(String accessToken, String tokenType, long expiresIn, UserSummary user) {

    public static LoginResponse bearer(String accessToken, long expiresIn, UserSummary user) {
        return new LoginResponse(accessToken, "Bearer", expiresIn, user);
    }
}
