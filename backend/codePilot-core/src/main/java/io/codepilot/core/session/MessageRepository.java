package io.codepilot.core.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import javax.sql.DataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Persists individual messages to MySQL for session replay and reconnection. */
@Component
public class MessageRepository {

  private static final Logger log = LoggerFactory.getLogger(MessageRepository.class);

  private final JdbcTemplate jdbc;
  private final ObjectMapper mapper =
      new ObjectMapper()
          .findAndRegisterModules()
          .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);

  public MessageRepository(DataSource dataSource) {
    this.jdbc = new JdbcTemplate(dataSource);
  }

  public void save(Message msg, String sessionId) {
    try {
      String toolCallsJson =
          msg.toolCalls() != null ? mapper.writeValueAsString(msg.toolCalls()) : null;
      String usageJson = msg.usage() != null ? mapper.writeValueAsString(msg.usage()) : null;
      jdbc.update(
          "INSERT INTO agent_messages (id, session_id, role, content, tool_calls_json, "
              + "tool_call_id, tool_name, thinking, usage_json) VALUES (?,?,?,?,?,?,?,?,?)",
          msg.id(),
          sessionId,
          msg.role().name(),
          msg.content(),
          toolCallsJson,
          msg.toolCallId(),
          msg.toolName(),
          msg.thinking(),
          usageJson);
    } catch (Exception e) {
      log.warn("Failed to save message {} for session {}", msg.id(), sessionId, e);
    }
  }

  public List<Message> loadBySession(String sessionId) {
    try {
      List<Map<String, Object>> rows =
          jdbc.queryForList(
              "SELECT * FROM agent_messages WHERE session_id = ? ORDER BY created_at", sessionId);
      List<Message> result = new ArrayList<>();
      for (var row : rows) {
        result.add(Message.fromRow(row, mapper));
      }
      return result;
    } catch (Exception e) {
      log.warn("Failed to load messages for session {}", sessionId, e);
      return List.of();
    }
  }
}
