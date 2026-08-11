import { afterEach, describe, expect, it, vi } from "vitest";

const coreMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@actions/core", () => coreMocks);

import { Logger } from "../src/logger.js";

describe("Logger", () => {
  afterEach(() => {
    delete process.env.ACTIONS_STEP_DEBUG;
    vi.clearAllMocks();
  });

  it("honours levels and uses GitHub Actions debug output when enabled", () => {
    const errorsOnly = new Logger("unexpected");
    errorsOnly.error("error");
    errorsOnly.warn("warning");
    expect(errorsOnly.level).toBe("info");
    expect(coreMocks.error).toHaveBeenCalledWith("error");
    expect(coreMocks.warning).toHaveBeenCalledWith("warning");

    const quiet = new Logger("error");
    quiet.info("hidden");
    quiet.debug("hidden");
    expect(coreMocks.info).not.toHaveBeenCalled();

    const debug = new Logger("debug");
    debug.debug("fallback debug");
    expect(coreMocks.info).toHaveBeenCalledWith("[debug] fallback debug");

    process.env.ACTIONS_STEP_DEBUG = "true";
    debug.debug("actions debug");
    expect(coreMocks.debug).toHaveBeenCalledWith("actions debug");
  });
});
