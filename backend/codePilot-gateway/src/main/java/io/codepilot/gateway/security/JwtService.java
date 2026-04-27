package io.codepilot.gateway.security;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.JWSSigner;
import com.nimbusds.jose.JWSVerifier;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.crypto.MACVerifier;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import io.codepilot.common.config.SecurityProperties;
import java.text.ParseException;
import java.time.Instant;
import java.util.Date;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Issues / validates HS256 JWT tokens.
 *
 * <p>Uses {@code nimbus-jose-jwt}. Tokens carry: {@code sub} (user id), {@code tid} (tenant),
 * {@code did} (device id), {@code scp} (scopes).
 */
@Service
public class JwtService {

  private static final String CLAIM_TENANT = "tid";
  private static final String CLAIM_DEVICE = "did";
  private static final String CLAIM_SCOPES = "scp";

  private final SecurityProperties props;
  private final JWSSigner signer;
  private final JWSVerifier verifier;

  public JwtService(SecurityProperties props) throws JOSEException {
    this.props = props;
    byte[] secret = props.jwtSecret().getBytes();
    this.signer = new MACSigner(secret);
    this.verifier = new MACVerifier(secret);
  }

  public Issued issueAccess(String userId, String tenantId, String deviceId, Set<String> scopes) {
    var now = Instant.now();
    var exp = now.plus(props.jwt().accessTtl());
    return new Issued(buildToken(userId, tenantId, deviceId, scopes, now, exp), exp);
  }

  public Issued issueRefresh(String userId, String tenantId, String deviceId) {
    var now = Instant.now();
    var exp = now.plus(props.jwt().refreshTtl());
    return new Issued(buildToken(userId, tenantId, deviceId, Set.of("refresh"), now, exp), exp);
  }

  public AuthPrincipal verify(String token) {
    try {
      SignedJWT jwt = SignedJWT.parse(token);
      if (!jwt.verify(verifier)) {
        throw new IllegalArgumentException("invalid signature");
      }
      JWTClaimsSet claims = jwt.getJWTClaimsSet();
      Date exp = claims.getExpirationTime();
      if (exp == null || exp.before(new Date())) {
        throw new IllegalArgumentException("expired");
      }
      Object scopesClaim = claims.getClaim(CLAIM_SCOPES);
      Set<String> scopes;
      if (scopesClaim instanceof List<?> list) {
        scopes = Set.copyOf(list.stream().map(Object::toString).toList());
      } else {
        scopes = Set.of();
      }
      return new AuthPrincipal(
          claims.getSubject(),
          (String) claims.getClaim(CLAIM_TENANT),
          (String) claims.getClaim(CLAIM_DEVICE),
          scopes,
          exp.toInstant().getEpochSecond());
    } catch (ParseException | JOSEException e) {
      throw new IllegalArgumentException("invalid token");
    }
  }

  private String buildToken(
      String userId,
      String tenantId,
      String deviceId,
      Set<String> scopes,
      Instant now,
      Instant exp) {
    try {
      JWTClaimsSet claims =
          new JWTClaimsSet.Builder()
              .subject(userId)
              .claim(CLAIM_TENANT, tenantId)
              .claim(CLAIM_DEVICE, deviceId)
              .claim(CLAIM_SCOPES, scopes)
              .jwtID(UUID.randomUUID().toString())
              .issueTime(Date.from(now))
              .expirationTime(Date.from(exp))
              .build();
      SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), claims);
      jwt.sign(signer);
      return jwt.serialize();
    } catch (JOSEException e) {
      throw new IllegalStateException("Failed to sign JWT", e);
    }
  }

  public record Issued(String token, Instant expiresAt) {}
}