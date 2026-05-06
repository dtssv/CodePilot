package io.codepilot.api.model;

import io.codepilot.common.api.ApiResponse;
import io.codepilot.core.model.CustomModelProvider;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.model.dto.CreateModelCommand;
import io.codepilot.core.model.dto.TestModelCommand;
import io.codepilot.core.model.dto.UpdateModelCommand;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** CRUD endpoints for custom model providers (per-user, OpenAI-compatible). */
@Tag(name = "model", description = "Custom model provider management")
@RestController
@RequestMapping(value = "/v1/models", produces = MediaType.APPLICATION_JSON_VALUE)
public class ModelController {

  private final ModelService modelService;

  public ModelController(ModelService modelService) {
    this.modelService = modelService;
  }

  @Operation(summary = "Create a custom model provider")
  @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<CustomModelProvider> create(@RequestBody @Valid CreateModelRequest req) {
    var cmd = new CreateModelCommand(req.userId(), req.name(), req.protocol(), req.baseUrl(), req.apiKey(), req.model(), req.headers(), req.timeoutMs());
    CustomModelProvider created = modelService.create(cmd);
    return ApiResponse.ok(created);
  }

  @Operation(summary = "Update a custom model provider")
  @PutMapping(value = "/{id}", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<CustomModelProvider> update(
      @PathVariable UUID id, @RequestBody @Valid UpdateModelRequest req) {
    var cmd = new UpdateModelCommand(req.name(), req.protocol(), req.baseUrl(), req.apiKey(), req.model(), req.headers(), req.timeoutMs(), req.enabled());
    CustomModelProvider updated = modelService.update(id, cmd);
    return ApiResponse.ok(updated);
  }

  @Operation(summary = "Delete a custom model provider")
  @DeleteMapping("/{id}")
  public ApiResponse<Map<String, Boolean>> delete(@PathVariable UUID id) {
    modelService.delete(id);
    return ApiResponse.ok(Map.of("deleted", true));
  }

  @Operation(summary = "Test connection to a custom model provider")
  @PostMapping(value = "/test", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<Map<String, Object>> test(@RequestBody @Valid TestModelRequest req) {
    var cmd = new TestModelCommand(req.protocol(), req.baseUrl(), req.apiKey(), req.model(), req.headers(), req.timeoutMs());
    Map<String, Object> result = modelService.testConnection(cmd);
    return ApiResponse.ok(result);
  }

  // ---- DTOs ---- //

  public record CreateModelRequest(
      @NotNull UUID userId,
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
}