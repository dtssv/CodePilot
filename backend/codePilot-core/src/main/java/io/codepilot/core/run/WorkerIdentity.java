package io.codepilot.core.run;

import java.net.InetAddress;
import java.util.UUID;
import org.springframework.stereotype.Component;

/** Stable worker id for this JVM (used in run lease claims). */
@Component
public class WorkerIdentity {

  private final String workerId;

  public WorkerIdentity() {
    String host = "unknown";
    try {
      host = InetAddress.getLocalHost().getHostName();
    } catch (Exception ignored) {
      // use default
    }
    this.workerId = host + "-" + UUID.randomUUID().toString().substring(0, 8);
  }

  public String id() {
    return workerId;
  }
}
