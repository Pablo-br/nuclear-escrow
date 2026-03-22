import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests are slow (on-chain round-trips); allow generous timeouts.
    // Individual timeouts are set per test (e.g. 60_000ms).
    testTimeout: 120_000,
    hookTimeout: 120_000,

    // Run tests sequentially — each test mutates on-chain state that the
    // next test may depend on (period open → proof → finalized).
    pool:        "forks",
    poolOptions: { forks: { singleFork: true } },

    // Show full test names in output
    reporter: "verbose",
  },
});
