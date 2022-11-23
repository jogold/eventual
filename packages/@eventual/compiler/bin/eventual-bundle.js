#! /usr/bin/env node
import { bundle } from "../lib/eventual-bundle.js";

try {
  const [, , outDir, entry, orchestratorEntry, activityWorkerEntry] =
    process.argv;
  if (!(outDir && entry && orchestratorEntry && activityWorkerEntry)) {
    throw new Error(
      `Usage: eventual-build <out-dir> <entry-point> <orchestratorEntry, <activityWorkerEntry>`
    );
  }
  await bundle(outDir, {
    workflow: entry,
    orchestrator: orchestratorEntry,
    activityWorker: activityWorkerEntry,
  });
} catch (err) {
  console.error(err);
  process.exit(1);
}
