package com.eventhub.users.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Files;
import java.nio.file.Path;

import com.eventhub.users.support.TestKeys;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class PemKeysTest {

    @TempDir
    Path dir;

    @Test
    void readsValidPkcs8Key() throws Exception {
        Path f = TestKeys.writePem(dir.resolve("ok.pem"), TestKeys.generate(2048));
        assertThat(PemKeys.readRsaPrivateKey(f).getModulus().bitLength()).isEqualTo(2048);
    }

    @Test
    void rejectsKeysSmallerThan2048Bits() throws Exception {
        Path f = TestKeys.writePem(dir.resolve("small.pem"), TestKeys.generate(1024));
        assertThatThrownBy(() -> PemKeys.readRsaPrivateKey(f)).hasMessageContaining("2048");
    }

    @Test
    void rejectsPkcs1AndGarbageAndMissingWithoutLeakingContent() throws Exception {
        Path pkcs1 = Files.writeString(dir.resolve("p1.pem"), "-----BEGIN RSA PRIVATE KEY-----\nSEGREDO\n");
        Path garbage = Files.writeString(dir.resolve("g.pem"), "SEGREDO-NAO-VAZAR");
        assertThatThrownBy(() -> PemKeys.readRsaPrivateKey(pkcs1)).hasMessageContaining("PKCS#8");
        assertThatThrownBy(() -> PemKeys.readRsaPrivateKey(garbage))
                .isInstanceOf(IllegalStateException.class).hasMessageNotContaining("SEGREDO");
        assertThatThrownBy(() -> PemKeys.readRsaPrivateKey(dir.resolve("nao-existe.pem")))
                .hasMessageContaining("gen-dev-keys.sh");
    }
}
