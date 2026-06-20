package io.codepilot.api.model;

import io.codepilot.common.api.ApiResponse;
import io.codepilot.core.model.CustomModelProvider;
import io.codepilot.core.model.ModelAppKey;
import io.codepilot.core.model.ModelGroup;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.model.dto.CreateModelCommand;
import io.codepilot.core.model.dto.TestModelCommand;
import io.codepilot.core.model.dto.UpdateModelCommand;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * CRUD endpoints for model providers.
 *
 * <ul>
 *   <li>GET /v1/models — lists system models + user's custom models
 *   <li>POST/PUT/DELETE — only operate on user's own custom models (ownership verified)
 * </ul>
 */
@Tag(name = "model", description = "Model provider management (system + custom)")
@RestController
@RequestMapping(value = "/v1/models", produces = MediaType.APPLICATION_JSON_VALUE)
public class ModelController {

  private final ModelService modelService;

  public ModelController(ModelService modelService) {
    this.modelService = modelService;
  }

  @Operation(summary = "List available models (system + user's custom)")
  @GetMapping
  public ApiResponse<Map<String, Object>> list(
      @RequestHeader(value = "X-User-Id", required = false) String userId) {
    Map<String, Object> result = modelService.listModels(userId);
    return ApiResponse.ok(result);
  }

  @Operation(summary = "Create a custom model provider (user-owned)")
  @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<CustomModelProvider> create(
      @RequestHeader("X-User-Id") String userId, @RequestBody @Valid CreateModelRequest req) {
    var cmd =
        new CreateModelCommand(
            userId,
            req.name(),
            req.protocol(),
            req.baseUrl(),
            req.apiKey(),
            req.model(),
            req.headers(),
            req.timeoutMs());
    CustomModelProvider created = modelService.create(cmd);
    return ApiResponse.ok(created);
  }

  @Operation(summary = "Update a custom model provider (only own models)")
  @PutMapping(value = "/{id}", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<CustomModelProvider> update(
      @RequestHeader("X-User-Id") String userId,
      @PathVariable UUID id,
      @RequestBody @Valid UpdateModelRequest req) {
    var cmd =
        new UpdateModelCommand(
            req.name(),
            req.protocol(),
            req.baseUrl(),
            req.apiKey(),
            req.model(),
            req.headers(),
            req.timeoutMs(),
            req.enabled());
    CustomModelProvider updated = modelService.update(id, userId, cmd);
    return ApiResponse.ok(updated);
  }

  @Operation(summary = "Delete a custom model provider (only own models)")
  @DeleteMapping("/{id}")
  public ApiResponse<Map<String, Boolean>> delete(
      @RequestHeader("X-User-Id") String userId, @PathVariable UUID id) {
    modelService.delete(id, userId);
    return ApiResponse.ok(Map.of("deleted", true));
  }

  @Operation(summary = "Test connection to a model provider")
  @PostMapping(value = "/test", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<Map<String, Object>> test(@RequestBody @Valid TestModelRequest req) {
    var cmd =
        new TestModelCommand(
            req.protocol(),
            req.baseUrl(),
            req.apiKey(),
            req.model(),
            req.headers(),
            req.timeoutMs());
    Map<String, Object> result = modelService.testConnection(cmd);
    return ApiResponse.ok(result);
  }

  // ---- DTOs ---- //

  public record CreateModelRequest(
      @NotBlank String name,
      @NotBlank String protocol,
      @NotBlank String baseUrl,
      @NotBlank String apiKey,
      @NotBlank String model,
      Map<String, String> headers,
      Integer timeoutMs) {}

  public record UpdateModelRequest(
      String name,
      String protocol,
      String baseUrl,
      String apiKey,
      String model,
      Map<String, String> headers,
      Integer timeoutMs,
      Boolean enabled) {}

  public record TestModelRequest(
      @NotBlank String protocol,
      @NotBlank String baseUrl,
      @NotBlank String apiKey,
      @NotBlank String model,
      Map<String, String> headers,
      Integer timeoutMs) {}

  // ---- Model Group endpoints ---- //

  @Operation(summary = "List all model groups")
  @GetMapping("/groups")
  public ApiResponse<List<ModelGroup>> listGroups() {
    return ApiResponse.ok(modelService.listModelGroups());
  }

  @Operation(summary = "Get a model group by ID")
  @GetMapping("/groups/{id}")
  public ApiResponse<ModelGroup> getGroup(@PathVariable UUID id) {
    ModelGroup group = modelService.findModelGroupById(id);
    return ApiResponse.ok(group);
  }

  @Operation(summary = "Create a new model group")
  @PostMapping(value = "/groups", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<ModelGroup> createGroup(@RequestBody @Valid CreateModelGroupRequest req) {
    ModelGroup created =
        modelService.createModelGroup(
            req.name(),
            req.protocol(),
            req.baseUrl(),
            req.model(),
            req.capabilities(),
            req.maxTokens(),
            req.timeoutMs(),
            req.sortOrder());
    return ApiResponse.ok(created);
  }

  @Operation(summary = "Update a model group")
  @PutMapping(value = "/groups/{id}", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<ModelGroup> updateGroup(
      @PathVariable UUID id, @RequestBody @Valid UpdateModelGroupRequest req) {
    ModelGroup updated =
        modelService.updateModelGroup(
            id,
            req.name(),
            req.protocol(),
            req.baseUrl(),
            req.model(),
            req.capabilities(),
            req.maxTokens(),
            req.timeoutMs(),
            req.enabled(),
            req.sortOrder());
    return ApiResponse.ok(updated);
  }

  @Operation(summary = "Delete a model group (cascades to app keys)")
  @DeleteMapping("/groups/{id}")
  public ApiResponse<Map<String, Boolean>> deleteGroup(@PathVariable UUID id) {
    modelService.deleteModelGroup(id);
    return ApiResponse.ok(Map.of("deleted", true));
  }

  // ---- Model App Key endpoints ---- //

  @Operation(summary = "List all app keys for a model group")
  @GetMapping("/groups/{groupId}/keys")
  public ApiResponse<List<ModelAppKey>> listAppKeys(@PathVariable UUID groupId) {
    return ApiResponse.ok(modelService.listAppKeysByGroup(groupId));
  }

  @Operation(summary = "Add an app key to a model group")
  @PostMapping(value = "/groups/{groupId}/keys", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<ModelAppKey> createAppKey(
      @PathVariable UUID groupId, @RequestBody @Valid CreateAppKeyRequest req) {
    ModelAppKey created =
        modelService.createAppKey(
            groupId,
            req.name(),
            req.baseUrl(),
            req.apiKey(),
            req.weight(),
            req.maxConcurrency() != null ? req.maxConcurrency() : 0,
            req.rpmLimit() != null ? req.rpmLimit() : 0,
            req.tpmLimit() != null ? req.tpmLimit() : 0,
            req.priority() != null ? req.priority() : 0);
    return ApiResponse.ok(created);
  }

  @Operation(summary = "Update an app key")
  @PutMapping(value = "/keys/{id}", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<ModelAppKey> updateAppKey(
      @PathVariable UUID id, @RequestBody @Valid UpdateAppKeyRequest req) {
    ModelAppKey updated =
        modelService.updateAppKey(
            id,
            req.name(),
            req.baseUrl(),
            req.apiKey(),
            req.weight(),
            req.maxConcurrency(),
            req.rpmLimit(),
            req.tpmLimit(),
            req.priority(),
            req.enabled());
    return ApiResponse.ok(updated);
  }

  @Operation(summary = "Delete an app key")
  @DeleteMapping("/keys/{id}")
  public ApiResponse<Map<String, Boolean>> deleteAppKey(@PathVariable UUID id) {
    modelService.deleteAppKey(id);
    return ApiResponse.ok(Map.of("deleted", true));
  }

  // ---- Model Group DTOs ---- //

  public record CreateModelGroupRequest(
      @NotBlank String name,
      @NotBlank String protocol,
      @NotBlank String baseUrl,
      @NotBlank String model,
      List<String> capabilities,
      Integer maxTokens,
      Integer timeoutMs,
      Integer sortOrder) {}

  public record UpdateModelGroupRequest(
      String name,
      String protocol,
      String baseUrl,
      String model,
      List<String> capabilities,
      Integer maxTokens,
      Integer timeoutMs,
      Boolean enabled,
      Integer sortOrder) {}

  public record CreateAppKeyRequest(
      @NotBlank String name,
      String baseUrl,
      @NotBlank String apiKey,
      Integer weight,
      Integer maxConcurrency,
      Integer rpmLimit,
      Integer tpmLimit,
      Integer priority) {}

  public record UpdateAppKeyRequest(
      String name,
      String baseUrl,
      String apiKey,
      Integer weight,
      Integer maxConcurrency,
      Integer rpmLimit,
      Integer tpmLimit,
      Integer priority,
      Boolean enabled) {}
}
