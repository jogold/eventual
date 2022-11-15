import { createEvent } from "../clients/execution-history-client.js";
import {
  WorkflowEvent,
  isFailed,
  isResolved,
  isResult,
  isWorkflowStarted,
  WorkflowCompleted,
  WorkflowEventType,
  WorkflowTaskStarted,
  WorkflowTaskCompleted,
  WorkflowFailed,
  interpret,
  isHistoryEvent,
  Command,
  Program,
  ActivityScheduled,
  HistoryStateEvents,
  CompleteExecution,
  FailedExecution,
  ExecutionStatus,
  isCompleteExecution,
} from "@eventual/core";
import { SQSWorkflowTaskMessage } from "../clients/workflow-client.js";
import {
  createExecutionHistoryClient,
  createWorkflowRuntimeClient,
} from "../clients/index.js";
import { SQSHandler, SQSRecord } from "aws-lambda";
import { createMetricsLogger, Unit } from "aws-embedded-metrics";
import { timed, timedSync } from "../metric-utils.js";
import { workflowName } from "../env.js";

const executionHistoryClient = createExecutionHistoryClient();
const workflowRuntimeClient = createWorkflowRuntimeClient();

/**
 * Creates an entrypoint function for orchestrating a workflow.
 */
export function orchestrator(
  program: (...args: any[]) => Program<any>
): SQSHandler {
  return async (event) => {
    console.debug("Handle workflowQueue records");
    // if a polling request
    if (event.Records.some((r) => !r.attributes.MessageGroupId)) {
      throw new Error("Expected SQS Records to contain fifo message id");
    }

    // batch by execution id
    const eventsByExecutionId = event.Records.reduce(
      (obj: Record<string, SQSRecord[]>, r) => ({
        ...obj,
        [r.attributes.MessageGroupId!]: [
          ...(obj[r.attributes.MessageGroupId!] || []),
          r,
        ],
      }),
      {}
    );

    const executionIds = Object.keys(eventsByExecutionId);

    console.log("Found execution ids: " + executionIds.join(", "));

    // TODO: handle errors and partial batch failures
    // for each execution id
    await Promise.all(
      Object.entries(eventsByExecutionId).map(([executionId, records]) =>
        orchestrateExecution(executionId, records)
      )
    );

    return {
      batchItemFailures: [],
    };

    function sqsRecordsToEvents(sqsRecords: SQSRecord[]) {
      return sqsRecords.flatMap(sqsRecordToEvents);
    }

    function sqsRecordToEvents(sqsRecord: SQSRecord) {
      const message = JSON.parse(sqsRecord.body) as SQSWorkflowTaskMessage;

      return message.task.events;
    }

    async function orchestrateExecution(
      executionId: string,
      records: SQSRecord[]
    ) {
      const metrics = createMetricsLogger();
      metrics.resetDimensions(false);
      metrics.setNamespace("Eventual");
      metrics.setDimensions({ WorkflowName: workflowName() });
      const events = sqsRecordsToEvents(records);
      const start = new Date();
      try {
        // number of events that came from the workflow task
        metrics.setProperty("TaskEvents", events.length);
        // number of workflow tasks that are being processed in the batch (max: 10)
        metrics.setProperty("AggregatedTasks", records.length);

        /** Events to be written to the history table at the end of the workflow task */
        const newEvents: WorkflowEvent[] = [];

        metrics.setProperty("ExecutionId", executionId);
        metrics.setProperty("Version", "v1");
        // length of time the oldest SQS record was in the queue.
        const maxTaskAge = Math.max(
          ...records.map(
            (r) => new Date().getTime() - Number(r.attributes.SentTimestamp)
          )
        );
        metrics.putMetric("MaxTaskAge", maxTaskAge, Unit.Milliseconds);

        // max number of times the sqs record was received by pollers.
        // use the max because any subsequent tasks are considered
        // an aggregation of the oldest task.
        // Lambda FIFO SQS poller would allow for a max of 10 workflow tasks to be
        // processed in a batch.
        metrics.setProperty(
          "MaxTaskReceived",
          Math.max(
            ...records.map((r) => Number(r.attributes.ApproximateReceiveCount))
          )
        );

        newEvents.push(
          createEvent<WorkflowTaskStarted>({
            type: WorkflowEventType.WorkflowTaskStarted,
          })
        );

        console.debug("Load history");
        // load history
        const history = await timed(metrics, "LoadHistoryDuration", async () =>
          workflowRuntimeClient.getHistory(executionId)
        );

        metrics.setProperty("LoadedHistoryEvents", history.length);

        // historical events and incoming events will be fed into the workflow to resume/progress state
        const inputEvents = [...history, ...events];

        console.debug(
          "Running workflow with events: " + JSON.stringify(inputEvents)
        );
        const startEvent = inputEvents.find(isWorkflowStarted);

        if (!startEvent) {
          throw new Error(
            "No workflow started event found for execution id: " + executionId
          );
        }

        console.log("program: " + program);

        // execute workflow
        const interpretEvents = inputEvents.filter(isHistoryEvent);
        const { result, commands: newCommands } = timedSync(
          metrics,
          "AdvanceExecutionDuration",
          () => interpret(program(startEvent.input), interpretEvents)
        );
        metrics.setProperty("AdvanceExecutionEvents", interpretEvents.length);

        console.debug("Workflow terminated with: " + JSON.stringify(result));

        console.info(`Found ${newCommands.length} new commands.`);

        const commandEvents = await timed(
          metrics,
          "InvokeCommandsDuration",
          () => processCommands(newCommands)
        );

        metrics.putMetric("CommandsInvoked", newCommands.length, Unit.Count);

        // tracks the time it takes for a workflow task to be scheduled until new commands could be emitted.
        // This represent the workflow orchestration time of User Perceived Latency
        // Average expected time for an activity to be invoked until it is considered complete by the workflow should follow:
        // AvgActivityDuration(N) = Avg(TimeToCommandsInvoked) + Avg(ActivityDuration(N))
        metrics.putMetric(
          "TimeToCommandsInvoked",
          maxTaskAge + (new Date().getTime() - start.getTime())
        );

        newEvents.push(...commandEvents);

        const newHistoryEvents = [...inputEvents, ...commandEvents];

        // update history from new commands and events
        // for now, we'll just write the awaitable command events to s3 as those are the ones needed to reconstruct the workflow.
        const { bytes: historyUpdatedBytes } = await timed(
          metrics,
          "SaveHistoryDuration",
          () =>
            workflowRuntimeClient.updateHistory(executionId, newHistoryEvents)
        );

        metrics.setProperty("SavedHistoryEvents", newHistoryEvents.length);
        metrics.putMetric("SavedHistoryBytes", historyUpdatedBytes, Unit.Bytes);

        newEvents.push(
          createEvent<WorkflowTaskCompleted>({
            type: WorkflowEventType.WorkflowTaskCompleted,
          })
        );

        // if the workflow is complete, add success and failure to the commands.
        if (isResult(result)) {
          if (isFailed(result)) {
            const [error, message] =
              result.error instanceof Error
                ? [result.error.name, result.error.message]
                : ["Error", JSON.stringify(result.error)];

            newEvents.push(
              createEvent<WorkflowFailed>({
                type: WorkflowEventType.WorkflowFailed,
                error,
                message,
              })
            );

            const execution = await timed(
              metrics,
              "ExecutionStatusUpdateDuration",
              () =>
                workflowRuntimeClient.failExecution(executionId, error, message)
            );

            logExecutionCompleteMetrics(execution);
          } else if (isResolved<any>(result)) {
            newEvents.push(
              createEvent<WorkflowCompleted>({
                type: WorkflowEventType.WorkflowCompleted,
                output: result.value,
              })
            );

            const execution = await timed(
              metrics,
              "ExecutionStatusUpdateDuration",
              () =>
                workflowRuntimeClient.completeExecution(
                  executionId,
                  result.value
                )
            );
            logExecutionCompleteMetrics(execution);
          }
        }

        await timed(metrics, "AddNewExecutionEventsDuration", () =>
          executionHistoryClient.putEvents(executionId, newEvents)
        );
        metrics.setProperty("NewExecutionEvents", newEvents.length);

        function logExecutionCompleteMetrics(
          execution: CompleteExecution | FailedExecution
        ) {
          metrics.putMetric(
            "ExecutionComplete",
            execution.status === ExecutionStatus.COMPLETE ? 1 : 0,
            Unit.Count
          );
          metrics.putMetric(
            "ExecutionFailed",
            execution.status === ExecutionStatus.COMPLETE ? 0 : 1,
            Unit.Count
          );
          console.log("logging for execution" + JSON.stringify(execution));
          metrics.putMetric(
            "ExecutionTotalDuration",
            new Date(execution.endTime).getTime() -
              new Date(execution.startTime).getTime()
          );
          if (isCompleteExecution(execution)) {
            metrics.putMetric(
              "ExecutionResultBytes",
              execution.result ? JSON.stringify(execution.result).length : 0,
              Unit.Bytes
            );
          }
        }

        /**
         * Generate events from commands and create a function which will start the commands.
         *
         * Does not actually write the commands out.
         */
        async function processCommands(
          commands: Command[]
        ): Promise<HistoryStateEvents[]> {
          // register command events
          return await Promise.all(
            commands.map(async (command) => {
              await workflowRuntimeClient.scheduleActivity(
                executionId,
                command
              );

              return createEvent<ActivityScheduled>({
                type: WorkflowEventType.ActivityScheduled,
                seq: command.seq,
                name: command.name,
              });
            })
          );
        }
      } finally {
        await metrics.flush();
      }
    }
  };
}
