import {
  EventualServiceClient,
  ExecutionID,
  LogLevel,
  TaskContext,
  TaskNotFoundError,
} from "@eventual/core";
import {
  ServiceType,
  TaskFailed,
  TaskRuntimeContext,
  TaskSucceeded,
  WorkflowEventType,
  extendsError,
  isAsyncResult,
  isWorkflowFailed,
  registerEntityHook,
  registerServiceClient,
  serviceTypeScope,
  taskContextScope,
} from "@eventual/core/internal";
import { EntityClient } from "../clients/entity-client.js";
import type { EventClient } from "../clients/event-client.js";
import type { ExecutionQueueClient } from "../clients/execution-queue-client.js";
import type { MetricsClient } from "../clients/metrics-client.js";
import type { TaskWorkerRequest } from "../clients/task-client.js";
import { TimerClient, TimerRequestType } from "../clients/timer-client.js";
import type { WorkflowClient } from "../clients/workflow-client.js";
import { hookConsole, restoreConsole } from "../console-hook.js";
import type { LogAgent, TaskLogContext } from "../log-agent.js";
import { MetricsCommon, TaskMetrics } from "../metrics/constants/index.js";
import { Unit } from "../metrics/unit.js";
import { timed } from "../metrics/utils.js";
import type { TaskProvider } from "../providers/task-provider.js";
import { normalizeError } from "../result.js";
import { computeDurationSeconds } from "../schedule.js";
import type { TaskStore } from "../stores/task-store.js";
import { createTaskToken } from "../task-token.js";
import { createEvent } from "../workflow-events.js";
import {
  TaskFallbackRequest,
  TaskFallbackRequestType,
} from "./task-fallback-handler.js";

export interface CreateTaskWorkerProps {
  taskProvider: TaskProvider;
  taskStore: TaskStore;
  eventClient: EventClient;
  executionQueueClient: ExecutionQueueClient;
  logAgent: LogAgent;
  metricsClient: MetricsClient;
  serviceClient?: EventualServiceClient;
  serviceName: string;
  timerClient: TimerClient;
  entityClient: EntityClient;
}

export interface TaskWorker {
  (
    request: TaskWorkerRequest,
    baseTime?: Date,
    /**
     * Allows for a computed end time, for case like the test environment when the end time should be controlled.
     */
    getEndTime?: (startTime: Date) => Date
  ): Promise<void | TaskFallbackRequest>;
}

/**
 * Creates a generic function for handling task worker requests
 * that can be used in runtime implementations. This implementation is
 * decoupled from a runtime's specifics by the clients. A runtime must
 * inject its own client implementations designed for that platform.
 */
export function createTaskWorker({
  taskProvider,
  taskStore,
  executionQueueClient,
  metricsClient,
  logAgent,
  serviceClient,
  serviceName,
  timerClient,
  entityClient,
}: CreateTaskWorkerProps): TaskWorker {
  // make the service client available to all task code
  if (serviceClient) {
    registerServiceClient(serviceClient);
  }
  registerEntityHook(entityClient);

  return metricsClient.metricScope(
    (metrics) =>
      async (
        request: TaskWorkerRequest,
        baseTime: Date = new Date(),
        getEndTime = () => new Date()
      ) => {
        try {
          return await serviceTypeScope(ServiceType.TaskWorker, async () => {
            const taskHandle = logAgent.isLogLevelSatisfied(LogLevel.DEBUG)
              ? `${request.taskName}:${request.seq} for execution ${request.executionId} on retry ${request.retry}`
              : request.taskName;
            metrics.resetDimensions(false);
            metrics.setNamespace(MetricsCommon.EventualNamespace);
            metrics.putDimensions({
              [TaskMetrics.TaskNameDimension]: request.taskName,
              [MetricsCommon.ServiceNameDimension]: serviceName,
            });
            metrics.setProperty(
              MetricsCommon.WorkflowName,
              request.workflowName
            );
            // the time from the workflow emitting the task scheduled command
            // to the request being seen.
            const taskLogContext: TaskLogContext = {
              taskName: request.taskName,
              executionId: request.executionId,
              seq: request.seq,
            };
            const start = baseTime;
            const recordAge =
              start.getTime() - new Date(request.scheduledTime).getTime();
            metrics.putMetric(
              TaskMetrics.TaskRequestAge,
              recordAge,
              Unit.Milliseconds
            );
            if (
              !(await timed(metrics, TaskMetrics.ClaimDuration, () =>
                taskStore.claim(request.executionId, request.seq, request.retry)
              ))
            ) {
              metrics.putMetric(TaskMetrics.ClaimRejected, 1, Unit.Count);
              console.debug(`Task ${taskHandle} already claimed.`);
              return;
            }
            if (request.heartbeat) {
              await timerClient.startTimer({
                taskSeq: request.seq,
                type: TimerRequestType.TaskHeartbeatMonitor,
                executionId: request.executionId,
                heartbeatSeconds: computeDurationSeconds(request.heartbeat),
                schedule: request.heartbeat,
              });
            }
            const runtimeContext: TaskRuntimeContext = {
              execution: {
                id: request.executionId as ExecutionID,
                workflowName: request.workflowName,
              },
              invocation: {
                token: createTaskToken(request.executionId, request.seq),
                scheduledTime: request.scheduledTime,
                retry: request.retry,
              },
            };
            metrics.putMetric(TaskMetrics.ClaimRejected, 0, Unit.Count);

            logAgent.logWithContext(taskLogContext, LogLevel.DEBUG, [
              `Processing ${taskHandle}.`,
            ]);

            const task = taskProvider.getTask(request.taskName);

            const event = await taskContextScope(
              runtimeContext,
              async () => await runTask()
            );

            if (event) {
              try {
                // try to complete the task
                await finishTask(event);
              } catch (err) {
                // if we fail to report the task result, fallback
                // to using the async function on success destination.
                // on success => sqs => pipe (CompletionPipe) => workflow queue
                return {
                  type: TaskFallbackRequestType.TaskSendEventFailure,
                  event,
                  executionId: request.executionId,
                };
              } finally {
                logTaskCompleteMetrics(
                  isWorkflowFailed(event),
                  new Date(event.timestamp).getTime() - start.getTime()
                );
              }
            }

            return;

            async function runTask() {
              try {
                if (!task) {
                  metrics.putMetric(TaskMetrics.NotFoundError, 1, Unit.Count);
                  throw new TaskNotFoundError(
                    request.taskName,
                    taskProvider.getTaskIds()
                  );
                }

                const context: TaskContext = {
                  task: {
                    name: task.name,
                  },
                  execution: runtimeContext.execution,
                  invocation: runtimeContext.invocation,
                };

                hookConsole((level, data) => {
                  logAgent.logWithContext(taskLogContext, level, data);
                  return undefined;
                });

                const result = await timed(
                  metrics,
                  TaskMetrics.OperationDuration,
                  () => task.handler(request.input, context)
                );

                restoreConsole();

                if (isAsyncResult(result)) {
                  metrics.setProperty(TaskMetrics.HasResult, 0);
                  metrics.setProperty(TaskMetrics.AsyncResult, 1);

                  // TODO: Send heartbeat on sync task completion.

                  /**
                   * The task has declared that it is async, other than logging, there is nothing left to do here.
                   * The task should call {@link WorkflowClient.sendTaskSuccess} or {@link WorkflowClient.sendTaskFailure} when it is done.
                   */
                  return timed(metrics, TaskMetrics.TaskLogWriteDuration, () =>
                    logAgent.flush()
                  );
                } else if (result) {
                  metrics.setProperty(TaskMetrics.HasResult, 1);
                  metrics.setProperty(TaskMetrics.AsyncResult, 0);
                  metrics.putMetric(
                    TaskMetrics.ResultBytes,
                    JSON.stringify(result).length,
                    Unit.Bytes
                  );
                } else {
                  metrics.setProperty(TaskMetrics.HasResult, 0);
                  metrics.setProperty(TaskMetrics.AsyncResult, 0);
                }

                logAgent.logWithContext(taskLogContext, LogLevel.DEBUG, [
                  `Task ${taskHandle} succeeded, reporting back to execution.`,
                ]);

                const endTime = getEndTime(start);
                return createEvent<TaskSucceeded>(
                  {
                    type: WorkflowEventType.TaskSucceeded,
                    seq: request.seq,
                    result,
                  },
                  endTime
                );
              } catch (err) {
                const [error, message] = extendsError(err)
                  ? [err.name, err.message]
                  : ["Error", JSON.stringify(err)];

                logAgent.logWithContext(taskLogContext, LogLevel.DEBUG, [
                  `Task ${taskHandle} failed, reporting failure back to execution: ${error}: ${message}`,
                ]);

                const endTime = getEndTime(start);
                return createEvent<TaskFailed>(
                  {
                    type: WorkflowEventType.TaskFailed,
                    seq: request.seq,
                    error,
                    message,
                  },
                  endTime
                );
              }
            }

            function logTaskCompleteMetrics(failed: boolean, duration: number) {
              metrics.putMetric(
                TaskMetrics.TaskFailed,
                failed ? 1 : 0,
                Unit.Count
              );
              metrics.putMetric(
                TaskMetrics.TaskSucceeded,
                failed ? 0 : 1,
                Unit.Count
              );
              // The total time from the task being scheduled until it's result is send to the workflow.
              metrics.putMetric(TaskMetrics.TotalDuration, duration);
            }

            async function finishTask(event: TaskSucceeded | TaskFailed) {
              const logFlush = timed(
                metrics,
                TaskMetrics.TaskLogWriteDuration,
                () => logAgent.flush()
              );
              await timed(metrics, TaskMetrics.SubmitWorkflowTaskDuration, () =>
                executionQueueClient.submitExecutionEvents(
                  request.executionId,
                  event
                )
              );
              await logFlush;
            }
          });
        } catch (err) {
          // as a final fallback, report the task as failed if anything failed an was not yet caught.
          // TODO: support retries
          return {
            type: TaskFallbackRequestType.TaskSendEventFailure,
            executionId: request.executionId,
            event: {
              type: WorkflowEventType.TaskFailed,
              ...normalizeError(err),
              timestamp: getEndTime(baseTime).toISOString(),
              seq: request.seq,
            },
          };
        }
      }
  );
}
