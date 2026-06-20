package io.codepilot.core.memory;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.model.ChatClientFactory;
import io.codepilot.core.prompt.PromptRegistry;
import org.junit.jupiter.api.Test;

class SessionMemoryDistillServiceTest {

  @Test
  void detectsRememberTrigger() {
    var service = new SessionMemoryDistillService(null, null, new ObjectMapper());
    assertThat(service.userRequestedMemoryPersistence("请记住使用 pnpm")).isTrue();
    assertThat(service.userRequestedMemoryPersistence("继续编译")).isFalse();
    assertThat(service.userRequestedMemoryPersistence("please remember this convention")).isTrue();
  }
}
