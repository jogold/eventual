import {
  AwaitedEventual,
  Eventual,
  EventualKind,
  EventualSymbol,
} from "./eventual.js";
import { registerActivity } from "./global.js";
import type { Program } from "./interpret.js";
import type { Result } from "./result.js";
import { Context, WorkflowContext } from "./context.js";
import { DeterminismError } from "./error.js";
import {
  filterEvents,
  HistoryStateEvents,
  isHistoryEvent,
  isWorkflowStarted,
  WorkflowEventType,
} from "./events.js";
import { interpret, WorkflowResult } from "./interpret.js";

export interface ExecutionHandle {
  /**
   * ID of the workflow execution.
   */
  executionId: string;
}

/**
 * A {@link Workflow} is a long-running process that orchestrates calls
 * to other services in a durable and observable way.
 */
export interface Workflow<
  F extends (...args: any[]) => any = (...args: any[]) => any
> {
  id: string;
  /**
   * Invokes
   */
  (...args: Parameters<F>): ReturnType<F>;
  /**
   * Starts an execution of this {@link Workflow} without waiting for the response.
   *
   * @returns a {@link ExecutionHandle} with the `executionId`.
   */
  startExecution(...args: Parameters<F>): Promise<ExecutionHandle>;

  /**
   * @internal - this is the internal DSL representation that produces a {@link Program} instead of a Promise.
   */
  definition: (
    ...args: Parameters<F>
  ) => Program<AwaitedEventual<ReturnType<F>>>;
}

/**
 * Creates and registers a long-running workflow.
 *
 * Example:
 * ```ts
 * import { activity, workflow } from "@eventual/core";
 *
 * export default workflow("my-workflow", async ({ name }: { name: string }) => {
 *   const result = await hello(name);
 *   console.log(result);
 *   return `you said ${result}`;
 * });
 *
 * const hello = activity("hello", async (name: string) => {
 *   return `hello ${name}`;
 * });
 * ```
 * @param id a globally unique ID for this workflow.
 * @param definition the workflow definition.
 */
export function workflow<F extends (...args: any[]) => Promise<any> | Program>(
  id: string,
  definition: F
): Workflow<F> {
  const workflow: Workflow<F> = ((...args: any[]) =>
    registerActivity({
      [EventualSymbol]: EventualKind.WorkflowCall,
      id,
      args,
    })) as any;

  // TODO:
  // workflow.start = function start(...args) {};

  workflow.definition = definition as Workflow<F>["definition"]; // safe to cast because we rely on transformer (it is always the generator API)
  return workflow;
}

export function isWorkflowCall<T>(a: Eventual<T>): a is WorkflowCall<T> {
  return a[EventualSymbol] === EventualKind.WorkflowCall;
}

/**
 * An {@link Eventual} representing an awaited call to a {@link Workflow}.
 */
export interface WorkflowCall<T = any> {
  [EventualSymbol]: EventualKind.WorkflowCall;
  id: string;
  args: any[];
  result?: Result<T>;
}

export interface ProgressWorkflowResult extends WorkflowResult {
  history: HistoryStateEvents[];
}

/**
 * Advance a workflow using previous history, new events, and a program.
 */
export function progressWorkflow(
  program: (...args: any[]) => Program<any>,
  historyEvents: HistoryStateEvents[],
  taskEvents: HistoryStateEvents[],
  workflowContext: WorkflowContext,
  executionId: string
): ProgressWorkflowResult {
  // historical events and incoming events will be fed into the workflow to resume/progress state
  const inputEvents = filterEvents<HistoryStateEvents>(
    historyEvents,
    taskEvents
  );

  const startEvent = inputEvents.find(isWorkflowStarted);

  if (!startEvent) {
    throw new DeterminismError(
      `No ${WorkflowEventType.WorkflowStarted} found.`
    );
  }

  const context: Context = {
    workflow: workflowContext,
    execution: {
      ...startEvent.context,
      id: executionId,
      startTime: startEvent.timestamp,
    },
  };

  // execute workflow
  const interpretEvents = inputEvents.filter(isHistoryEvent);
  return {
    ...interpret(program(startEvent.input, context), interpretEvents),
    history: inputEvents,
  };
}
