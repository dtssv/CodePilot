package io.codepilot.core.session;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonProperty;
import io.codepilot.core.permission.PermissionRuleset;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Typed, mutable state object for a single session.
 *
 * <p>This replaces the old {@code AgentState} and the graph-based {@code OverAllState}. It is the
 * single source of truth for the entire session lifecycle.
 */
public class SessionState {

  // ── Identity ──
  private final String sessionId;
  private String userId;
  private String modelId;
  private String modelSource;

  // ── Conversation ──
  private final List<Message> messages = Collections.synchronizedList(new ArrayList<>());
  private String input;

  // ── Execution tracking ──
  private SessionStatus status = SessionStatus.IDLE;
  private int turnCount = 0;
  private int maxTurns = 50;
  private int consecutiveFailures = 0;
  private boolean stopped = false;
  private TerminalReason terminalReason;

  // ── Goal condition ──
  private String goalCondition;
  private boolean explicitGoalCondition = false;
  private int goalFailCount = 0;

  // ── File tracking ──
  private final Set<String> filesRead = Collections.synchronizedSet(new LinkedHashSet<>());
  private final Set<String> filesWritten = Collections.synchronizedSet(new LinkedHashSet<>());

  // ── Context budget ──
  private int estimatedTokens = 0;
  private int maxContextTokens = 128_000;

  // ── Project context ──
  private String projectMeta = "";
  private String projectRootHash = "";
  private String workspaceRoot = "";
  private String osHint = "";
  private List<Map<String, Object>> mcpTools = List.of();
  private List<String> projectRules = List.of();

  // ── Language ──
  private String language = "en";

  // ── Memory ──
  private String memoryContext = "";

  // ── Per-session permission overrides (transient; merged after agent rules) ──
  private PermissionRuleset permissionOverride;

  // ── Checkpoint ──
  private String checkpointToken;
  private Instant lastCheckpointAt;

  // ── Metadata ──
  private final Map<String, String> metadata = Collections.synchronizedMap(new LinkedHashMap<>());
  private final Instant createdAt = Instant.now();

  // ── Token accumulation ──
  private int totalInputTokens = 0;
  private int totalOutputTokens = 0;
  private double totalCost = 0.0;

  // ── Subagents ──
  private final Map<String, SessionState> subagents =
      Collections.synchronizedMap(new LinkedHashMap<>());

  public SessionState(String sessionId, String userId, String modelId) {
    this.sessionId = sessionId;
    this.userId = userId;
    this.modelId = modelId;
  }

  /** Why the session ended. */
  public enum TerminalReason {
    @JsonProperty("task_complete")
    TASK_COMPLETE,
    @JsonProperty("awaiting_input")
    AWAITING_INPUT,
    @JsonProperty("context_overflow")
    CONTEXT_OVERFLOW,
    @JsonProperty("user_stopped")
    USER_STOPPED,
    @JsonProperty("max_turns")
    MAX_TURNS,
    @JsonProperty("failure_exhausted")
    FAILURE_EXHAUSTED,
    @JsonProperty("goal_not_met")
    GOAL_NOT_MET,
    @JsonProperty("error")
    ERROR
  }

  // ── Getters / Setters ──

  public String getSessionId() {
    return sessionId;
  }

  public String getUserId() {
    return userId;
  }

  public void setUserId(String userId) {
    this.userId = userId;
  }

  public String getModelId() {
    return modelId;
  }

  public void setModelId(String modelId) {
    this.modelId = modelId;
  }

  public String getModelSource() {
    return modelSource;
  }

  public void setModelSource(String modelSource) {
    this.modelSource = modelSource;
  }

  public List<Message> getMessages() {
    return messages;
  }

  public String getInput() {
    return input;
  }

  public void setInput(String input) {
    this.input = input;
  }

  public SessionStatus getStatus() {
    return status;
  }

  public void setStatus(SessionStatus status) {
    this.status = status;
  }

  public int getTurnCount() {
    return turnCount;
  }

  public void incrementTurn() {
    this.turnCount++;
  }

  public int getMaxTurns() {
    return maxTurns;
  }

  public void setMaxTurns(int maxTurns) {
    this.maxTurns = maxTurns;
  }

  public int getConsecutiveFailures() {
    return consecutiveFailures;
  }

  public void recordSuccess() {
    this.consecutiveFailures = 0;
  }

  public void recordFailure() {
    this.consecutiveFailures++;
  }

  public boolean isStopped() {
    return stopped;
  }

  public void setStopped(boolean stopped) {
    this.stopped = stopped;
  }

  public TerminalReason getTerminalReason() {
    return terminalReason;
  }

  public void setTerminalReason(TerminalReason reason) {
    this.terminalReason = reason;
  }

  public Set<String> getFilesRead() {
    return filesRead;
  }

  public void addFileRead(String path) {
    this.filesRead.add(path);
  }

  public Set<String> getFilesWritten() {
    return filesWritten;
  }

  public void addFileWritten(String path) {
    this.filesWritten.add(path);
  }

  public String getCurrentAgent() {
    return currentAgent;
  }

  public void setCurrentAgent(String agent) {
    this.currentAgent = agent;
  }

  private String currentAgent = "build";

  public int getEstimatedTokens() {
    return estimatedTokens;
  }

  public void setEstimatedTokens(int tokens) {
    this.estimatedTokens = tokens;
  }

  public void addEstimatedTokens(int delta) {
    this.estimatedTokens += delta;
  }

  public int getMaxContextTokens() {
    return maxContextTokens;
  }

  public void setMaxContextTokens(int max) {
    this.maxContextTokens = max;
  }

  public String getProjectMeta() {
    return projectMeta;
  }

  public void setProjectMeta(String meta) {
    this.projectMeta = meta;
  }

  public String getProjectRootHash() {
    return projectRootHash;
  }

  public void setProjectRootHash(String hash) {
    this.projectRootHash = hash;
  }

  public String getWorkspaceRoot() {
    return workspaceRoot;
  }

  public void setWorkspaceRoot(String root) {
    this.workspaceRoot = root;
  }

  public String getOsHint() {
    return osHint;
  }

  public void setOsHint(String hint) {
    this.osHint = hint;
  }

  public List<Map<String, Object>> getMcpTools() {
    return mcpTools;
  }

  public void setMcpTools(List<Map<String, Object>> tools) {
    this.mcpTools = tools;
  }

  public List<String> getProjectRules() {
    return projectRules;
  }

  public void setProjectRules(List<String> rules) {
    this.projectRules = rules;
  }

  public String getLanguage() {
    return language;
  }

  public void setLanguage(String language) {
    this.language = language;
  }

  public String getMemoryContext() {
    return memoryContext;
  }

  public void setMemoryContext(String memoryContext) {
    this.memoryContext = memoryContext;
  }

  @JsonIgnore
  public PermissionRuleset getPermissionOverride() {
    return permissionOverride;
  }

  public void setPermissionOverride(PermissionRuleset permissionOverride) {
    this.permissionOverride = permissionOverride;
  }

  public String getCheckpointToken() {
    return checkpointToken;
  }

  public void setCheckpointToken(String token) {
    this.checkpointToken = token;
  }

  public Instant getLastCheckpointAt() {
    return lastCheckpointAt;
  }

  public void setLastCheckpointAt(Instant at) {
    this.lastCheckpointAt = at;
  }

  public Map<String, String> getMetadata() {
    return metadata;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public int getTotalInputTokens() {
    return totalInputTokens;
  }

  public int getTotalOutputTokens() {
    return totalOutputTokens;
  }

  public double getTotalCost() {
    return totalCost;
  }

  public void addTokenUsage(int inputTokens, int outputTokens, double cost) {
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalCost += cost;
  }

  public String getGoalCondition() {
    return goalCondition;
  }

  public void setGoalCondition(String goalCondition) {
    this.goalCondition = goalCondition;
  }

  public boolean hasExplicitGoalCondition() {
    return explicitGoalCondition;
  }

  public void setExplicitGoalCondition(boolean explicitGoalCondition) {
    this.explicitGoalCondition = explicitGoalCondition;
  }

  public int getGoalFailCount() {
    return goalFailCount;
  }

  public void incrementGoalFailCount() {
    this.goalFailCount++;
  }

  public void resetGoalFailCount() {
    this.goalFailCount = 0;
  }

  // ── Message helpers ──

  public void addMessage(Message message) {
    this.messages.add(message);
  }

  public void addSystemMessage(String content) {
    this.messages.add(Message.system(content));
  }

  public void addUserMessage(String content) {
    this.messages.add(Message.user(content));
  }

  public void addAssistantMessage(
      String content,
      List<Message.ToolCallEntry> toolCalls,
      String thinking,
      Message.TokenUsage usage) {
    this.messages.add(Message.assistant(content, toolCalls, thinking, usage));
  }

  public void addToolResult(String toolCallId, String toolName, String content) {
    this.messages.add(Message.toolResult(toolCallId, toolName, content));
  }

  // ── Subagents ──

  public void addSubagent(String name, SessionState state) {
    subagents.put(name, state);
  }

  public Map<String, SessionState> getSubagents() {
    return Map.copyOf(subagents);
  }

  // ── Status checks ──

  public boolean needsCompaction() {
    return estimatedTokens > maxContextTokens * 0.8;
  }

  public boolean shouldStop() {
    return stopped || terminalReason != null || turnCount >= maxTurns || consecutiveFailures >= 5;
  }

  public boolean isTerminal() {
    return status == SessionStatus.COMPLETED
        || status == SessionStatus.ERROR
        || status == SessionStatus.CANCELLED;
  }
}
