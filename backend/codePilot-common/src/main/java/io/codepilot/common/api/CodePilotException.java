package io.codepilot.common.api;

/**
 * Typed exception that carries a stable {@link ErrorCodes} value. Callers never
 * expose
 * {@link Throwable#getMessage()} to users unless it is already user-facing.
 */
public class CodePilotException extends RuntimeException {

    private final int code;

    public CodePilotException(int code, String userFacingMessage) {
        super(userFacingMessage);
        this.code = code;
    }

    public CodePilotException(int code, String userFacingMessage, Throwable cause) {
        super(userFacingMessage, cause);
        this.code = code;
    }

    public int code() {
        return code;
    }
}