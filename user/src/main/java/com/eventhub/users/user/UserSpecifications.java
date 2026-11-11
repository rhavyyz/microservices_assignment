package com.eventhub.users.user;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

import jakarta.persistence.criteria.Predicate;

import org.springframework.data.jpa.domain.Specification;

/** Filtros da busca de usuários, combinados com AND. Todo valor vai como parâmetro vinculado (sem concatenar SQL). */
final class UserSpecifications {

    private static final char ESCAPE = '\\';

    private UserSpecifications() {
    }

    /**
     * @param id        igualdade exata (opcional)
     * @param emailTerm trecho do e-mail, sem diferenciar maiúsculas (opcional; o e-mail é gravado em minúsculas)
     * @param nameTerm  trecho do nome, sem diferenciar maiúsculas (opcional)
     */
    static Specification<User> matching(UUID id, String emailTerm, String nameTerm) {
        return (root, query, cb) -> {
            List<Predicate> predicates = new ArrayList<>();
            if (id != null) {
                predicates.add(cb.equal(root.get("id"), id));
            }
            if (emailTerm != null) {
                predicates.add(cb.like(root.<String>get("email"), contains(emailTerm.toLowerCase(Locale.ROOT)), ESCAPE));
            }
            if (nameTerm != null) {
                predicates.add(cb.like(cb.lower(root.<String>get("name")), contains(nameTerm.toLowerCase(Locale.ROOT)),
                        ESCAPE));
            }
            return cb.and(predicates.toArray(new Predicate[0]));
        };
    }

    /** Padrão LIKE "contém": {@code %} e {@code _} digitados pelo usuário valem como texto literal, não como curinga. */
    static String contains(String term) {
        StringBuilder sb = new StringBuilder(term.length() + 2).append('%');
        for (int i = 0; i < term.length(); i++) {
            char c = term.charAt(i);
            if (c == ESCAPE || c == '%' || c == '_') {
                sb.append(ESCAPE);
            }
            sb.append(c);
        }
        return sb.append('%').toString();
    }

    /**
     * Listagem do ADMIN: {@code term} procura no nome ou no e-mail (contém, sem diferenciar maiúsculas) e
     * {@code request} filtra pela situação do pedido de organizador. Ambos opcionais.
     */
    static Specification<User> forAdmin(String term, OrganizerRequest request) {
        return (root, query, cb) -> {
            List<Predicate> predicates = new ArrayList<>();
            if (term != null) {
                String like = contains(term.toLowerCase(Locale.ROOT));
                predicates.add(cb.or(cb.like(cb.lower(root.<String>get("name")), like, ESCAPE),
                        cb.like(root.<String>get("email"), like, ESCAPE)));
            }
            if (request != null) {
                predicates.add(cb.equal(root.get("organizerRequest"), request));
            }
            return cb.and(predicates.toArray(new Predicate[0]));
        };
    }
}
