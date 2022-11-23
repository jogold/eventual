import { APIGatewayProxyEventV2 } from "aws-lambda";
import { workflows } from "../env";
import { createWorkflowClient } from "../../../clients/create";
import middy from "@middy/core";
import { errorMiddleware } from "../middleware";

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
  const workflow = workflows[workflowName];
  if (!workflow) {
    return {
      statusCode: 400,
      body: `Workflow ${workflowName} does not exist!`,
    };
  }
  const workflowClient = createWorkflowClient(workflow);

  return {
    executionId: await workflowClient.startWorkflow({
      workflowName,
      input: event.body,
    }),
  };
}

export const handler = middy(newExecution).use(errorMiddleware);
