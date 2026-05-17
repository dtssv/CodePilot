package io.codepilot.api.speech;

import com.fasterxml.jackson.databind.JsonNode;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.client.MultipartBodyBuilder;
import org.springframework.http.codec.multipart.FilePart;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.reactive.function.BodyInserters;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.server.ResponseStatusException;
import reactor.core.publisher.Mono;
import org.springframework.core.io.buffer.DataBufferUtils;

/** OpenAI-compatible speech-to-text endpoint used by the IDE voice input bridge. */
@Tag(name = "speech", description = "Speech recognition")
@RestController
@RequestMapping(value = "/v1/speech", produces = MediaType.APPLICATION_JSON_VALUE)
public class SpeechController {

  private final WebClient http;
  private final String baseUrl;
  private final String apiKey;
  private final String model;

  public SpeechController(
      WebClient.Builder builder,
      @Value("${codepilot.speech.base-url:${spring.ai.openai.base-url:https://api.openai.com}}")
          String baseUrl,
      @Value("${codepilot.speech.api-key:${spring.ai.openai.api-key:}}") String apiKey,
      @Value("${codepilot.speech.model:${CODEPILOT_STT_MODEL:whisper-1}}") String model) {
    this.http = builder.build();
    this.baseUrl = stripTrailingSlash(baseUrl);
    this.apiKey = apiKey;
    this.model = model;
  }

  @Operation(summary = "Recognize speech from multipart audio")
  @PostMapping(value = "/recognize", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
  public Mono<Map<String, Object>> recognize(@RequestPart("audio") FilePart audio) {
    if (!StringUtils.hasText(apiKey) || "sk-xxx".equals(apiKey)) {
      return Mono.error(new ResponseStatusException(
          HttpStatus.SERVICE_UNAVAILABLE,
          "Speech recognition is not configured. Set codepilot.speech.api-key or spring.ai.openai.api-key."));
    }
    return DataBufferUtils.join(audio.content())
        .map(buffer -> {
          byte[] bytes = new byte[buffer.readableByteCount()];
          buffer.read(bytes);
          DataBufferUtils.release(buffer);
          return bytes;
        })
        .flatMap(bytes -> transcribe(audio.filename(), bytes))
        .map(text -> Map.<String, Object>of("text", text));
  }

  private Mono<String> transcribe(String filename, byte[] bytes) {
    MultipartBodyBuilder body = new MultipartBodyBuilder();
    body.part("model", model);
    body.part("file", new NamedByteArrayResource(bytes, filename))
        .filename(StringUtils.hasText(filename) ? filename : "recording.wav")
        .contentType(MediaType.APPLICATION_OCTET_STREAM);

    return http.post()
        .uri(transcriptionUrl())
        .headers(h -> h.setBearerAuth(apiKey))
        .contentType(MediaType.MULTIPART_FORM_DATA)
        .body(BodyInserters.fromMultipartData(body.build()))
        .retrieve()
        .onStatus(status -> status.isError(), resp ->
            resp.bodyToMono(String.class)
                .defaultIfEmpty("")
                .flatMap(msg -> Mono.error(new ResponseStatusException(
                    HttpStatus.BAD_GATEWAY,
                    "Speech provider failed: " + msg))))
        .bodyToMono(JsonNode.class)
        .map(json -> json.path("text").asText(""));
  }

  private String transcriptionUrl() {
    return baseUrl.endsWith("/v1")
        ? baseUrl + "/audio/transcriptions"
        : baseUrl + "/v1/audio/transcriptions";
  }

  private static String stripTrailingSlash(String s) {
    if (s == null) return "";
    return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
  }

  private static final class NamedByteArrayResource extends ByteArrayResource {
    private final String filename;

    private NamedByteArrayResource(byte[] byteArray, String filename) {
      super(byteArray);
      this.filename = StringUtils.hasText(filename) ? filename : "recording.wav";
    }

    @Override
    public String getFilename() {
      return filename;
    }
  }
}
