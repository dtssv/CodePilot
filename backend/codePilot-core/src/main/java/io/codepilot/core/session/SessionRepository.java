package io.codepilot.core.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import javax.sql.DataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Persists session state summaries to MySQL for resuming conversations and auditing. */
@Component
public class SessionRepository {

  private static final Logger log = LoggerFactory.getLogger(SessionRepository.class);

  private final JdbcTemplate jdbc;
  // findAndRegisterModules() pulls in jackson-datatype-jsr310 so java.time types
  // (Instant on SessionState) serialize/deserialize; ISO strings, not numeric timestamps.
  private final ObjectMapper mapper =
      new ObjectMapper()
          .findAndRegisterModules()
          .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);

  public SessionRepository(DataSource dataSource) {
    this.jdbc = new JdbcTemplate(dataSource);
  }

  public void save(SessionState session) {
    try {
      String json = mapper.writeValueAsString(session);
      jdbc.update(
          "INSERT INTO agent_sessions (id, user_id, model_id, model_source, status, "
              + "current_agent, goal_condition, session_json) VALUES (?,?,?,?,?,?,?,?) "
              + "ON DUPLICATE KEY UPDATE status=?, updated_at=NOW()",
          session.getSessionId(),
          session.getUserId(),
          session.getModelId(),
          session.getModelSource(),
          session.getStatus().name(),
          session.getCurrentAgent(),
          session.getGoalCondition(),
          json,
          session.getStatus().name());
    } catch (Exception e) {
      log.warn("Failed to save session {}", session.getSessionId(), e);
    }
  }

  /**
   * Load a previously persisted session. The conversation history is restored from the stored JSON
   * snapshot (the {@code messages} array), while scalar fields are read from the dedicated columns.
   * Returns empty if the session is unknown.
   */
  public java.util.Optional<SessionState> findById(String id) {
    try {
      var rows =
          jdbc.queryForList(
              "SELECT user_id, model_id, model_source, status, current_agent, goal_condition,"
                  + " session_json FROM agent_sessions WHERE id = ?",
              id);
      if (rows.isEmpty()) return java.util.Optional.empty();
      var row = rows.get(0);
      SessionState s =
          new SessionState(id, (String) row.get("user_id"), (String) row.get("model_id"));
      s.setModelSource((String) row.get("model_source"));
      Object agent = row.get("current_agent");
      if (agent != null) s.setCurrentAgent(agent.toString());
      s.setGoalCondition((String) row.get("goal_condition"));
      Object status = row.get("status");
      if (status != null) {
        try {
          s.setStatus(SessionStatus.valueOf(status.toString()));
        } catch (IllegalArgumentException ignore) {
          /* unknown status */
        }
      }
      String json = (String) row.get("session_json");
      if (json != null && !json.isBlank()) {
        var node = mapper.readTree(json);
        var msgsNode = node.get("messages");
        if (msgsNode != null && msgsNode.isArray()) {
          var listType =
              mapper.getTypeFactory().constructCollectionType(java.util.List.class, Message.class);
          java.util.List<Message> msgs = mapper.convertValue(msgsNode, listType);
          for (Message m : msgs) {
            s.addMessage(m);
          }
        }
        String input = node.path("input").asText(null);
        if (input != null && !input.isBlank()) s.setInput(input);
      }
      return java.util.Optional.of(s);
    } catch (Exception e) {
      log.warn("Failed to load session {}", id, e);
      return java.util.Optional.empty();
    }
  }
}
