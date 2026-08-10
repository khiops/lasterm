#!/usr/bin/env -S pnpm exec tsx
import { loadRuntime, requestHub } from "../../packages/hub/src/cli.js";

const runtime = loadRuntime();
if (runtime.kind === "absent") throw new Error("Hub runtime record is absent");
if (runtime.kind === "unreadable") throw new Error("Hub runtime record cannot be read");
const response = await requestHub(runtime.runtime, "/api/health", {
	signal: AbortSignal.timeout(2_000),
});
if (!response.ok) throw new Error(`Hub health check failed: HTTP ${response.status}`);
process.stdout.write(`${runtime.runtime.port}\n`);
