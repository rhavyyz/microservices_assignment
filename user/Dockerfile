# Image for the user service (Spring Boot, Java 21): register, login, profile; its own PostgreSQL (user-db).
# Registers with the service-discoverer as kind "user" via the shared Java discovery lib and serves /healthcheck and /openapi.json.
# The lib comes from the compose build context "discovery" (service-discoverer/Libs/java); it is installed into the
# local Maven repository of the build stage, then the service is built against it.
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /repo/user
COPY --from=discovery . /repo/service-discoverer/Libs/java
COPY pom.xml ./
COPY src src
RUN --mount=type=cache,target=/root/.m2 \
    mvn -B -q -f /repo/service-discoverer/Libs/java/pom.xml install -DskipTests \
 && mvn -B -q package -DskipTests

FROM eclipse-temurin:21-jre
RUN useradd --system --uid 10001 --no-create-home app
WORKDIR /app
COPY --from=build /repo/user/target/users-service-*.jar /app/app.jar
USER 10001
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
