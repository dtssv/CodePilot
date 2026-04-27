package io.codepilot.api.model;

import io.codepilot.common.api.ApiResponse;
import io.codepilot.common.model.CustomModel;
import io.codepilot.common.model.ModelListResponse;
import io.codepilot.common.model.ModelTestRequest;
import io.codepilot.common.model.ModelTestResult;
import io.codepilot.core.model.ModelService;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

/**
 * REST controller for model management endpoints.
 *
 * <ul>
 *   <li>{@code GET    /v1/models}          — list built-in + custom models</li>
 *   <li>{@code POST   /v1/models}          — create custom model</li>
 *   <li>{@code PUT    /v1/models/{id}}     — update custom model</li>
 *   <li>{@code DELETE /v1/models/{id}}     — delete custom model</li>
 *   <li>{@code POST   /v1/models/test}     — test model connectivity</li>
 * </ul>
 */
@RestController
@RequestMapping("/v1/models")
public class ModelController {

  /** Header name for the authenticated user ID (set by gateway JWT filter). */
  private static final String USER_ID_HEADER = "X-CodePilot-User-Id";

  private final ModelService modelService;

  public ModelController(ModelService modelService) {
    this.modelService = modelService;
  }

  /** GET /v1/models — list all models for the current user. */
  @GetMapping
  public Mono<ResponseEntity<ApiResponse<ModelListResponse>>> listModels(
      @RequestHeader(USER_ID_HEADER) String userId) {
    return modelService.listModels(userId)
        .map(resp -> ResponseEntity.ok(ApiResponse.ok(resp)));
  }

  /** POST /v1/models — create a custom model. */
  @PostMapping
  public Mono<ResponseEntity<ApiResponse<CustomModel>>> createCustomModel(
      @RequestHeader(USER_ID_HEADER) String userId,
      @Valid @RequestBody CustomModel request) {
    return modelService.createCustomModel(userId, request)
        .map(model -> ResponseEntity.ok(ApiResponse.ok(model)));
  }

  /** PUT /v1/models/{id} — update a custom model. */
  @PutMapping("/{id}")
  public Mono<ResponseEntity<ApiResponse<CustomModel>>> updateCustomModel(
      @RequestHeader(USER_ID_HEADER) String userId,
      @PathVariable long id,
      @Valid @RequestBody CustomModel request) {
    return modelService.updateCustomModel(userId, id, request)
        .map(model -> ResponseEntity.ok(ApiResponse.ok(model)));
  }

  /** DELETE /v1/models/{id} — delete a custom model. */
  @DeleteMapping("/{id}")
  public Mono<ResponseEntity<ApiResponse<Void>>> deleteCustomModel(
      @RequestHeader(USER_ID_HEADER) String userId,
      @PathVariable long id) {
    return modelService.deleteCustomModel(userId, id)
        .map(deleted -> deleted
            ? ResponseEntity.ok(ApiResponse.ok(null))
            : ResponseEntity.notFound().build());
  }

  /** POST /v1/models/test — test model connectivity before saving. */
  @PostMapping("/test")
  public Mono<ResponseEntity<ApiResponse<ModelTestResult>>> testModel(
      @Valid @RequestBody ModelTestRequest request) {
    return modelService.testModel(request)
        .map(result -> ResponseEntity.ok(ApiResponse.ok(result)));
  }
}