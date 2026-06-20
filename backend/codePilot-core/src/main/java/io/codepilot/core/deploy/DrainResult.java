package io.codepilot.core.deploy;

/** Outcome of a deploy drain request. */
public record DrainResult(
    boolean alreadyDraining, int activeAtStart, int remaining, boolean completedWithinTimeout) {}
