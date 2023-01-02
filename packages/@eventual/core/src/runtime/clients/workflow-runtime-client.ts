import { HistoryStateEvent, WorkflowEventType } from "../../workflow-events.js";
import { SucceededExecution, FailedExecution } from "../../execution.js";
import { ActivityWorkerRequest } from "../handlers/activity-worker.js";
import { WorkflowClient } from "./workflow-client.js";

export interface SucceedExecutionRequest {
  executionId: string;
  result?: any;
}

export interface FailExecutionRequest {
  executionId: string;
  error: string;
  message: string;
}

export function isFailedExecutionRequest(
  executionRequest: SucceedExecutionRequest | FailExecutionRequest
): executionRequest is FailExecutionRequest {
  return "error" in executionRequest;
}

export interface UpdateHistoryRequest {
  executionId: string;
  events: HistoryStateEvent[];
}

export abstract class WorkflowRuntimeClient {
  constructor(private workflowClient: WorkflowClient) {}
  public abstract getHistory(executionId: string): Promise<HistoryStateEvent[]>;

  // TODO: etag
  public abstract updateHistory(
    request: UpdateHistoryRequest
  ): Promise<{ bytes: number }>;

  public abstract startActivity(request: ActivityWorkerRequest): Promise<void>;

  public async succeedExecution(
    request: SucceedExecutionRequest
  ): Promise<SucceededExecution> {
    const execution = await this.updateExecution(request);
    console.log("execution", execution);
    if (execution.parent) {
      await this.reportCompletionToParent(
        execution.parent.executionId,
        execution.parent.seq,
        request.result
      );
    }

    return execution as SucceededExecution;
  }

  public async failExecution(
    request: FailExecutionRequest
  ): Promise<FailedExecution> {
    const execution = await this.updateExecution(request);
    if (execution.parent) {
      await this.reportCompletionToParent(
        execution.parent.executionId,
        execution.parent.seq,
        request.error,
        request.message
      );
    }

    return execution as FailedExecution;
  }

  protected abstract updateExecution(
    request: FailExecutionRequest | SucceedExecutionRequest
  ): Promise<SucceededExecution | FailedExecution>;

  private async reportCompletionToParent(
    parentExecutionId: string,
    seq: number,
    ...args: [result: any] | [error: string, message: string]
  ) {
    await this.workflowClient.submitWorkflowTask(parentExecutionId, {
      seq,
      timestamp: new Date().toISOString(),
      ...(args.length === 1
        ? {
            type: WorkflowEventType.ChildWorkflowSucceeded,
            result: args[0],
          }
        : {
            type: WorkflowEventType.ChildWorkflowFailed,
            error: args[0],
            message: args[1],
          }),
    });
  }
}
