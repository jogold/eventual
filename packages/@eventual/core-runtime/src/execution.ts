import { ExecutionID } from "@eventual/core";

export function isExecutionId(a: any): a is ExecutionID {
  return typeof a === "string" && a.split("/").length === 2;
}

export function parseWorkflowName(executionId: ExecutionID): string {
  return executionId.split("/")[0]!;
}

export function formatExecutionId<
  WorkflowName extends string,
  ID extends string
>(workflowName: string, id: string): ExecutionID<WorkflowName, ID> {
  return `${workflowName}/${id}` as ExecutionID<WorkflowName, ID>;
}

export function parseExecutionId(executionId: ExecutionID): {
  workflowName: string;
  executionName: string;
} {
  if (isExecutionId(executionId)) {
    const parts = executionId.split("/");
    return {
      workflowName: parts[0]!,
      executionName: parts.slice(1).join("/"),
    };
  }
  throw new Error("Invalid execution Id: " + executionId);
}

export const INTERNAL_EXECUTION_ID_PREFIX = "%";

/**
 * Formats an child workflow execution as a unique, deterministic name.
 * 1. we prefix it with {@link INTERNAL_EXECUTION_ID_PREFIX} to ensure it is impossible for a user to create it.
 * 2. we construct the name from the parent execution ID and the seq - this ensures uniqueness and is deterministic
 *
 * It must be deterministic to ensure idempotency.
 *
 * @param parentExecutionId id of the caller execution used to compute the child workflow name
 * @param seq position that started the child workflow
 */
export function formatChildExecutionName(
  parentExecutionId: string,
  seq: number
): string {
  return `${INTERNAL_EXECUTION_ID_PREFIX}${parentExecutionId.replace(
    "/",
    "-"
  )}-${seq}`;
}
