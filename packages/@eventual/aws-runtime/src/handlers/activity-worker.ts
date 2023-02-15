// the user's entry point will register activities as a side effect.
import "@eventual/injected/entry";

import {
  ActivityFallbackRequest,
  ActivityWorkerRequest,
  createActivityWorker,
  GlobalActivityProvider,
} from "@eventual/runtime-core";
import { AWSMetricsClient } from "../clients/metrics-client.js";
import {
  createActivityClient,
  createActivityStore,
  createEventClient,
  createExecutionQueueClient,
  createExecutionStore,
  createLogAgent,
  createServiceClient,
  createTimerClient,
} from "../create.js";
import { serviceName } from "../env.js";

const worker = createActivityWorker({
  executionQueueClient: createExecutionQueueClient(),
  eventClient: createEventClient(),
  timerClient: createTimerClient(),
  metricsClient: AWSMetricsClient,
  activityProvider: new GlobalActivityProvider(),
  // partially uses the runtime clients and partially uses the http client
  serviceClient: createServiceClient({
    activityClient: createActivityClient(),
    eventClient: createEventClient(),
    executionQueueClient: createExecutionQueueClient(),
    // already used by the activity client
    executionStore: createExecutionStore(),
  }),
  logAgent: createLogAgent(),
  activityStore: createActivityStore(),
  serviceName: serviceName(),
});

export default async (request: ActivityWorkerRequest) => {
  const result = await worker(request);

  /**
   * Throw fallback requests so that only lambda "failures" trigger the "on failure".
   */
  if (!!result) {
    throw new ActivityFallbackRequestError(result);
  }
};

export class ActivityFallbackRequestError extends Error {
  constructor(public request: ActivityFallbackRequest) {
    super(JSON.stringify(request));
  }
}
