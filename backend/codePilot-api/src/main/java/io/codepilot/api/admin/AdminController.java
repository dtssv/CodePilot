package io.codepilot.api.admin;

import io.codepilot.common.api.ApiResponse;
import io.codepilot.core.admin.AdminService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Admin dashboard API for session, user, and model management.
 * All endpoints require admin API key authentication (via {@link AdminAuthFilter}).
 */
@Tag(name = "admin", description = "Admin dashboard management APIs")
@RestController
@RequestMapping(value = "/v1/admin", produces = MediaType.APPLICATION_JSON_VALUE)
public class AdminController {

    private final AdminService adminService;

    public AdminController(AdminService adminService) {
        this.adminService = adminService;
    }

    // ==================== Session Management ====================

    @Operation(summary = "List sessions with pagination and filters")
    @GetMapping("/sessions")
    public ApiResponse<Map<String, Object>> listSessions(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String userId,
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) String startTime,
            @RequestParam(required = false) String endTime) {
        return ApiResponse.ok(adminService.listSessions(page, size, userId, keyword, startTime, endTime));
    }

    @Operation(summary = "Get session detail with events and tool call stats")
    @GetMapping("/sessions/{id}")
    public ApiResponse<Map<String, Object>> getSessionDetail(@PathVariable String id) {
        return ApiResponse.ok(adminService.getSessionDetail(id));
    }

    @Operation(summary = "Delete a session and its data")
    @DeleteMapping("/sessions/{id}")
    public ApiResponse<Map<String, Boolean>> deleteSession(@PathVariable String id) {
        adminService.deleteSession(id);
        return ApiResponse.ok(Map.of("deleted", true));
    }

    @Operation(summary = "Get session statistics")
    @GetMapping("/sessions/stats")
    public ApiResponse<Map<String, Object>> getSessionStats() {
        return ApiResponse.ok(adminService.getSessionStats());
    }

    // ==================== User Management ====================

    @Operation(summary = "List users with pagination and search")
    @GetMapping("/users")
    public ApiResponse<Map<String, Object>> listUsers(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String keyword) {
        return ApiResponse.ok(adminService.listUsers(page, size, keyword));
    }

    @Operation(summary = "Get user detail")
    @GetMapping("/users/{id}")
    public ApiResponse<Map<String, Object>> getUserDetail(@PathVariable String id) {
        return ApiResponse.ok(adminService.getUserDetail(id));
    }

    @Operation(summary = "Enable or disable a user")
    @PutMapping(value = "/users/{id}/status", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ApiResponse<Map<String, Boolean>> updateUserStatus(
            @PathVariable String id,
            @RequestBody UpdateStatusRequest req) {
        adminService.updateUserStatus(id, req.enabled());
        return ApiResponse.ok(Map.of("updated", true));
    }

    @Operation(summary = "Get user statistics")
    @GetMapping("/users/stats")
    public ApiResponse<Map<String, Object>> getUserStats() {
        return ApiResponse.ok(adminService.getUserStats());
    }

    // ==================== Model Management ====================

    @Operation(summary = "List models with pagination")
    @GetMapping("/models")
    public ApiResponse<Map<String, Object>> listModels(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size) {
        return ApiResponse.ok(adminService.listModels(page, size));
    }

    @Operation(summary = "Update model configuration (enable/disable, rate limit)")
    @PutMapping(value = "/models/{id}", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ApiResponse<Map<String, Boolean>> updateModelConfig(
            @PathVariable UUID id,
            @RequestBody UpdateModelConfigRequest req) {
        adminService.updateModelConfig(id, req.enabled(), req.rateLimitPerMinute());
        return ApiResponse.ok(Map.of("updated", true));
    }

    @Operation(summary = "Get model usage statistics")
    @GetMapping("/models/{id}/usage")
    public ApiResponse<Map<String, Object>> getModelUsage(@PathVariable UUID id) {
        return ApiResponse.ok(adminService.getModelUsage(id));
    }

    @Operation(summary = "Get model statistics (aggregate)")
    @GetMapping("/models/stats")
    public ApiResponse<Map<String, Object>> getModelStats() {
        return ApiResponse.ok(adminService.getModelStats());
    }

    // ==================== Request DTOs ====================

    public record UpdateStatusRequest(boolean enabled) {}

    public record UpdateModelConfigRequest(Boolean enabled, Integer rateLimitPerMinute) {}
}