import type { ExecutionID } from "@eventual/core";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
} from "aws-lambda";
import { createWorkflowClient } from "../../../clients/create.js";
import { withErrorMiddleware } from "../middleware.js";

const workflowClient = createWorkflowClient({
  activityTableName: "NOT_NEEDED",
});

/**
 * Create a new execution (start a workflow)
 * @param event
 * @returns
 */
async function newExecution(event: APIGatewayProxyEventV2) {
  const workflowName = event.pathParameters?.name;
  if (!workflowName) {
    return { statusCode: 400, body: `Missing workflow name` };
  }

  return {
    executionId: await workflowClient.startWorkflow({
      workflowName,
      input: event.body && JSON.parse(event.body),
    }),
  };
}

export const handler: APIGatewayProxyHandlerV2<{
  executionId: ExecutionID<string, string>;
}> = withErrorMiddleware(newExecution);
