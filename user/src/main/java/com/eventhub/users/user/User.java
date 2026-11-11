package com.eventhub.users.user;

import java.time.Instant;
import java.util.Collections;
import java.util.EnumSet;
import java.util.Set;
import java.util.UUID;

import jakarta.persistence.CollectionTable;
import jakarta.persistence.Column;
import jakarta.persistence.ElementCollection;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.Table;

/** Conta de usuário. {@code passwordHash} nunca sai desta camada para DTOs. */
@Entity
@Table(name = "users")
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(nullable = false, length = 120)
    private String name;

    @Column(nullable = false, length = 254)
    private String email;

    @Column(name = "password_hash", nullable = false, length = 100)
    private String passwordHash;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private UserStatus status;

    @ElementCollection(fetch = FetchType.EAGER)
    @CollectionTable(name = "user_roles", joinColumns = @JoinColumn(name = "user_id"))
    @Column(name = "role", nullable = false, length = 20)
    @Enumerated(EnumType.STRING)
    private Set<Role> roles = EnumSet.noneOf(Role.class);

    @Enumerated(EnumType.STRING)
    @Column(name = "organizer_request", nullable = false, length = 20)
    private OrganizerRequest organizerRequest = OrganizerRequest.NONE;

    @Column(name = "organizer_request_updated_at")
    private Instant organizerRequestUpdatedAt;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected User() {
        // exigido pelo JPA
    }

    public static User create(String name, String email, String passwordHash, Set<Role> roles, Instant now) {
        User u = new User();
        u.name = name;
        u.email = email;
        u.passwordHash = passwordHash;
        u.status = UserStatus.ACTIVE;
        u.roles = EnumSet.copyOf(roles);
        u.createdAt = now;
        u.updatedAt = now;
        return u;
    }

    public void rename(String newName, Instant now) {
        this.name = newName;
        this.updatedAt = now;
    }

    /** Cadastro que escolheu "organizador": continua sem o papel até um ADMIN decidir. */
    public void requestOrganizer(Instant now) {
        this.organizerRequest = OrganizerRequest.PENDING;
        this.organizerRequestUpdatedAt = now;
        this.updatedAt = now;
    }

    /** Decisão de um ADMIN: concede o papel ORGANIZER. */
    public void grantOrganizer(Instant now) {
        this.roles.add(Role.ORGANIZER);
        this.organizerRequest = OrganizerRequest.APPROVED;
        this.organizerRequestUpdatedAt = now;
        this.updatedAt = now;
    }

    /** Decisão de um ADMIN: nega o pedido ou retira o papel ORGANIZER. */
    public void denyOrganizer(Instant now) {
        this.roles.remove(Role.ORGANIZER);
        this.organizerRequest = OrganizerRequest.DENIED;
        this.organizerRequestUpdatedAt = now;
        this.updatedAt = now;
    }

    public void grantAdmin(Instant now) {
        this.roles.add(Role.ADMIN);
        this.updatedAt = now;
    }

    public UUID getId() {
        return id;
    }

    public String getName() {
        return name;
    }

    public String getEmail() {
        return email;
    }

    public String getPasswordHash() {
        return passwordHash;
    }

    public UserStatus getStatus() {
        return status;
    }

    public Set<Role> getRoles() {
        return Collections.unmodifiableSet(roles);
    }

    public OrganizerRequest getOrganizerRequest() {
        return organizerRequest;
    }

    public Instant getOrganizerRequestUpdatedAt() {
        return organizerRequestUpdatedAt;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }
}
