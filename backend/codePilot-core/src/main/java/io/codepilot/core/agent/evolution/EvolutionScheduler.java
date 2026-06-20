package io.codepilot.core.agent.evolution;

import io.codepilot.core.agent.distill.DistillService;
import io.codepilot.core.agent.dream.DreamService;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Drives the self-improvement loops on a schedule (in addition to manual triggers):
 *
 * <ul>
 *   <li><b>Dream</b> — weekly: consolidate/dedupe/validate project memory.
 *   <li><b>Distill</b> — monthly: turn recurring workflows into reusable skills.
 * </ul>
 *
 * <p>For each cycle the scheduler enumerates users who were active within the lookback window and
 * runs the corresponding self-improvement subagent for them (fire-and-forget; the resulting stream
 * is consumed for its side effects on memory/skills).
 */
@Component
public class EvolutionScheduler {

  private static final Logger log = LoggerFactory.getLogger(EvolutionScheduler.class);

  private final DreamService dreamService;
  private final DistillService distillService;
  private final JdbcTemplate jdbc;

  public EvolutionScheduler(
      DreamService dreamService, DistillService distillService, JdbcTemplate jdbc) {
    this.dreamService = dreamService;
    this.distillService = distillService;
    this.jdbc = jdbc;
  }

  /** Weekly dream — Sundays at 04:00 by default. */
  @Scheduled(cron = "${codepilot.evolution.dream-cron:0 0 4 * * SUN}")
  public void scheduledDream() {
    List<String> users = recentUsers(7);
    log.info("Scheduled dream: {} active users in the last 7 days", users.size());
    for (String userId : users) {
      try {
        dreamService
            .dream(userId, "default")
            .doOnError(e -> log.warn("Scheduled dream failed for {}: {}", userId, e.getMessage()))
            .subscribe();
      } catch (Exception e) {
        log.warn("Scheduled dream dispatch failed for {}", userId, e);
      }
    }
  }

  /** Monthly distill — 1st of the month at 05:00 by default. */
  @Scheduled(cron = "${codepilot.evolution.distill-cron:0 0 5 1 * *}")
  public void scheduledDistill() {
    List<String> users = recentUsers(30);
    log.info("Scheduled distill: {} active users in the last 30 days", users.size());
    for (String userId : users) {
      try {
        distillService
            .distill(userId, "default")
            .doOnError(e -> log.warn("Scheduled distill failed for {}: {}", userId, e.getMessage()))
            .subscribe();
      } catch (Exception e) {
        log.warn("Scheduled distill dispatch failed for {}", userId, e);
      }
    }
  }

  private List<String> recentUsers(int days) {
    try {
      // `days` is an int we control, so inlining it is injection-safe.
      String sql =
          "SELECT DISTINCT user_id FROM agent_sessions "
              + "WHERE user_id IS NOT NULL AND updated_at > (NOW() - INTERVAL "
              + days
              + " DAY) "
              + "LIMIT 200";
      return jdbc.queryForList(sql, String.class);
    } catch (Exception e) {
      log.debug("recentUsers query failed (table may be empty): {}", e.getMessage());
      return List.of();
    }
  }
}
