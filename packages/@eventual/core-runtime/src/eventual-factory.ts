import { EventualError, HeartbeatTimeout, Timeout } from "@eventual/core";
import {
  EventualCall,
  Result,
  WorkflowEventType,
  assertNever,
  isAwaitTimerCall,
  isChildWorkflowCall,
  isChildWorkflowScheduled,
  isConditionCall,
  isEntityCall,
  isEntityRequest,
  isEventsEmitted,
  isExpectSignalCall,
  isInvokeTransactionCall,
  isEmitEventsCall,
  isRegisterSignalHandlerCall,
  isSendSignalCall,
  isSignalSent,
  isTaskCall,
  isTaskScheduled,
  isTimerScheduled,
  isTransactionRequest,
} from "@eventual/core/internal";
import { EventualDefinition, Trigger } from "./workflow-executor.js";

export function createEventualFromCall(
  call: EventualCall
): EventualDefinition<any> {
  if (isTaskCall(call)) {
    return {
      triggers: [
        Trigger.onWorkflowEvent(WorkflowEventType.TaskSucceeded, (event) =>
          Result.resolved(event.result)
        ),
        Trigger.onWorkflowEvent(WorkflowEventType.TaskFailed, (event) =>
          Result.failed(new EventualError(event.error, event.message))
        ),
        Trigger.onWorkflowEvent(
          WorkflowEventType.TaskHeartbeatTimedOut,
          Result.failed(new HeartbeatTimeout("Task Heartbeat TimedOut"))
        ),
        call.timeout
          ? Trigger.onPromiseResolution(
              call.timeout,
              Result.failed(new Timeout("Task Timed Out"))
            )
          : undefined,
      ],
      isCorresponding(event) {
        return isTaskScheduled(event) && call.name === event.name;
      },
    };
  } else if (isChildWorkflowCall(call)) {
    return {
      triggers: [
        Trigger.onWorkflowEvent(
          WorkflowEventType.ChildWorkflowSucceeded,
          (event) => Result.resolved(event.result)
        ),
        Trigger.onWorkflowEvent(
          WorkflowEventType.ChildWorkflowFailed,
          (event) =>
            Result.failed(new EventualError(event.error, event.message))
        ),
        call.timeout
          ? Trigger.onPromiseResolution(
              call.timeout,
              Result.failed("Child Workflow Timed Out")
            )
          : undefined,
      ],
      isCorresponding(event) {
        return isChildWorkflowScheduled(event) && event.name === call.name;
      },
    };
  } else if (isAwaitTimerCall(call)) {
    return {
      triggers: Trigger.onWorkflowEvent(
        WorkflowEventType.TimerCompleted,
        Result.resolved(undefined)
      ),
      isCorresponding: isTimerScheduled,
    };
  } else if (isSendSignalCall(call)) {
    return {
      isCorresponding(event) {
        return isSignalSent(event) && event.signalId === call.signalId;
      },
      result: Result.resolved(undefined),
    };
  } else if (isExpectSignalCall(call)) {
    return {
      triggers: [
        Trigger.onSignal(call.signalId, (event) =>
          Result.resolved(event.payload)
        ),
        call.timeout
          ? Trigger.onPromiseResolution(
              call.timeout,
              Result.failed(new Timeout("Expect Signal Timed Out"))
            )
          : undefined,
      ],
    };
  } else if (isEmitEventsCall(call)) {
    return {
      isCorresponding: isEventsEmitted,
      result: Result.resolved(undefined),
    };
  } else if (isConditionCall(call)) {
    // if the condition resolves immediately, just return a completed eventual
    const result = call.predicate();
    if (result) {
      return {
        result: Result.resolved(result),
      };
    } else {
      // otherwise check the state after every event is applied.
      return {
        triggers: [
          Trigger.afterEveryEvent(() => {
            const result = call.predicate();
            return result ? Result.resolved(result) : undefined;
          }),
          call.timeout
            ? Trigger.onPromiseResolution(call.timeout, Result.resolved(false))
            : undefined,
        ],
      };
    }
  } else if (isRegisterSignalHandlerCall(call)) {
    return {
      triggers: Trigger.onSignal(call.signalId, (event) => {
        call.handler(event.payload);
      }),
    };
  } else if (isEntityCall(call)) {
    return {
      triggers: [
        Trigger.onWorkflowEvent(
          WorkflowEventType.EntityRequestSucceeded,
          (event) => Result.resolved(event.result)
        ),
        Trigger.onWorkflowEvent(
          WorkflowEventType.EntityRequestFailed,
          (event) =>
            Result.failed(new EventualError(event.error, event.message))
        ),
      ],
      isCorresponding(event) {
        return (
          isEntityRequest(event) &&
          call.operation === event.operation.operation &&
          "name" in call === "name" in event.operation &&
          (!("name" in call && "name" in event.operation) ||
            call.name === event.operation.name)
        );
      },
    };
  } else if (isInvokeTransactionCall(call)) {
    return {
      triggers: [
        Trigger.onWorkflowEvent(
          WorkflowEventType.TransactionRequestSucceeded,
          (event) => Result.resolved(event.result)
        ),
        Trigger.onWorkflowEvent(
          WorkflowEventType.TransactionRequestFailed,
          (event) =>
            Result.failed(new EventualError(event.error, event.message))
        ),
      ],
      isCorresponding(event) {
        return isTransactionRequest(event);
      },
    };
  }
  return assertNever(call);
}
