import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDocumentation } from "../../scripts/check-docs.js";

const root = resolve(".");

describe("release verification", () => {
  it("keeps release documentation and local links consistent", async () => {
    await expect(checkDocumentation(root)).resolves.toMatchObject({
      files: expect.any(Number),
      links: expect.any(Number),
    });
  });

  it("provides one consolidated container test entrypoint", async () => {
    const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    for (let phase = 1; phase <= 12; phase += 1) {
      expect(packageJson.scripts.test).toContain(`tests/phase${String(phase).padStart(2, "0")}`);
    }
    expect(packageJson.scripts["test:phase12"]).toContain("tests/phase12");
    expect(packageJson.scripts["check:docs"]).toBe("tsx scripts/check-docs.ts");
  });

  it("ships the lab and pinned upstream notices in runtime images", async () => {
    const dockerfile = await readFile(resolve(root, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("COPY LICENSE THIRD_PARTY_NOTICES.md /licenses/");
    expect(dockerfile).toContain("COPY licenses /licenses/upstream");

    const notices = await readFile(resolve(root, "THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notices).toContain("107d79f11072bbc8a3a757ed7fd69596bee7d68c");
    expect(notices).toContain("2dd67d76ad12961f92359153e03686773e3e8761");
  });

  it("places Docker TTY flags before the image for native auth setup", async () => {
    const launcher = await readFile(resolve(root, "route-agent"), "utf8");
    expect(launcher).toContain('set -- "$@" -it');
    expect(launcher).not.toContain('set -- "$@" -it --auth');
    expect(launcher).toContain('set -- "$@" --auth');
    expect(launcher).toContain('LAB_PHASE12_MOCK_TUI');
  });
});
