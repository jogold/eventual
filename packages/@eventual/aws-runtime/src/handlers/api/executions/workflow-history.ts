import { decodeExecutionId, HistoryStateEvent } from "@eventual/core";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
} from "aws-lambda";
import { createWorkflowRuntimeClient } from "../../../clients/index.js";
import { getService } from "../service-properties.js";
import { withErrorMiddleware } from "../middleware.js";

async function workflowHistory(event: APIGatewayProxyEventV2) {
  const executionId = event.pathParameters?.executionId;
  if (!executionId) {
    return { statusCode: 400, body: `Missing executionId` };
  }

  const workflowClient = createWorkflowRuntimeClient(getService());
  return workflowClient.getHistory(decodeExecutionId(executionId));
}

export const handler: APIGatewayProxyHandlerV2<HistoryStateEvent[]> =
  withErrorMiddleware(workflowHistory);
