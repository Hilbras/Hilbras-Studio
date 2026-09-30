import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(root, "src"),
      "server-only": resolve(root, "tests/mocks/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    passWithNoTests: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
    clearMocks: true,
    restoreMocks: true,

    // Each integration file starts its own Postgres container in `beforeAll`,
    // so Vitest's default — one worker per CPU — means one concurrent Postgres
    // per core. On a 2-core runner that is 18 at once, and v0.11.0's 18th file
    // is what tipped CI over: the run died with three 57P01
    // connection-terminations and no test summary at all. Every test in the
    // suite had passed; the process was killed underneath them, which is why it
    // looked like a bug in one test file rather than a ceiling reached by
    // adding a file.
    //
    // Verified: capped, the suite is 18/18 green on a 2-CPU machine in 169s.
    // Uncapped, the same run did not finish inside 300s.
    //
    // Capped rather than serialized so the suite stays parallel, but with a
    // bounded peak — the point is that the *next* file added does not reproduce
    // this.
    maxWorkers: 4,
  },
});
