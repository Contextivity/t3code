import { describe, expect, it } from "@effect/vitest";

import {
  CONTEXTIVITY_DISTRIBUTION_ENV,
  isContextivityDistributionFromEnv,
  UPSTREAM_NPM_UPDATE_REFUSAL,
} from "./contextivityDistribution.ts";
import { resolveServerSelfUpdateCapability } from "../cloud/selfUpdate.ts";

describe("Contextivity distribution identity", () => {
  it("detects the explicit distribution env and ignores other values", () => {
    expect(isContextivityDistributionFromEnv({ [CONTEXTIVITY_DISTRIBUTION_ENV]: "1" })).toBe(true);
    expect(isContextivityDistributionFromEnv({ [CONTEXTIVITY_DISTRIBUTION_ENV]: "true" })).toBe(
      true,
    );
    expect(isContextivityDistributionFromEnv({ [CONTEXTIVITY_DISTRIBUTION_ENV]: "0" })).toBe(false);
    expect(isContextivityDistributionFromEnv({})).toBe(false);
  });

  it("suppresses boot-service self-update so clients are not offered npx t3@<version>", () => {
    expect(
      resolveServerSelfUpdateCapability({
        desktopManaged: false,
        launcherManaged: true,
        contextivityDistribution: true,
      }),
    ).toBeNull();
    expect(
      resolveServerSelfUpdateCapability({
        desktopManaged: false,
        launcherManaged: true,
      }),
    ).toBe("boot-service");
    expect(UPSTREAM_NPM_UPDATE_REFUSAL).not.toMatch(/npx t3@/);
    expect(UPSTREAM_NPM_UPDATE_REFUSAL).toContain("t3-ctx");
  });
});
