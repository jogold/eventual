import { ConditionPredicate } from "../condition.js";
import {
  CompositeKey,
  EntityConsistencyOptions,
  EntityListRequest,
  EntitySetOptions,
  EntityTransactItem,
} from "../entity.js";
import { EventEnvelope } from "../event.js";
import { DurationSchedule, Schedule } from "../schedule.js";
import { WorkflowExecutionOptions } from "../workflow.js";
import { SignalTarget } from "./signal.js";

export type EventualCall =
  | AwaitTimerCall
  | ConditionCall
  | EntityCall
  | ChildWorkflowCall
  | ExpectSignalCall
  | InvokeTransactionCall
  | EmitEventsCall
  | RegisterSignalHandlerCall
  | SendSignalCall
  | TaskCall;

export enum EventualCallKind {
  AwaitTimerCall = 1,
  ConditionCall = 2,
  EntityCall = 8,
  ExpectSignalCall = 3,
  InvokeTransactionCall = 9,
  EmitEventsCall = 4,
  RegisterSignalHandlerCall = 5,
  SendSignalCall = 6,
  TaskCall = 0,
  WorkflowCall = 7,
}

const EventualCallSymbol = /* @__PURE__ */ Symbol.for("eventual:EventualCall");

export interface EventualCallBase<
  Kind extends EventualCall[typeof EventualCallSymbol]
> {
  [EventualCallSymbol]: Kind;
}

export function createEventualCall<E extends EventualCall>(
  kind: E[typeof EventualCallSymbol],
  e: Omit<E, typeof EventualCallSymbol>
): E {
  (e as E)[EventualCallSymbol] = kind;
  return e as E;
}

export function isEventualCall(a: any): a is EventualCall {
  return a && typeof a === "object" && EventualCallSymbol in a;
}

export function isEventualCallOfKind<E extends EventualCall>(
  kind: E[typeof EventualCallSymbol],
  a: any
): a is E {
  return isEventualCall(a) && a[EventualCallSymbol] === kind;
}

export function isAwaitTimerCall(a: any): a is AwaitTimerCall {
  return isEventualCallOfKind(EventualCallKind.AwaitTimerCall, a);
}

export interface AwaitTimerCall
  extends EventualCallBase<EventualCallKind.AwaitTimerCall> {
  schedule: Schedule;
}

export function isConditionCall(a: any): a is ConditionCall {
  return isEventualCallOfKind(EventualCallKind.ConditionCall, a);
}

export interface ConditionCall
  extends EventualCallBase<EventualCallKind.ConditionCall> {
  predicate: ConditionPredicate;
  timeout?: Promise<any>;
}

export function isEmitEventsCall(a: any): a is EmitEventsCall {
  return isEventualCallOfKind(EventualCallKind.EmitEventsCall, a);
}

export interface EmitEventsCall
  extends EventualCallBase<EventualCallKind.EmitEventsCall> {
  events: EventEnvelope[];
  id?: string;
}

export function isEntityCall(a: any): a is EntityCall {
  return isEventualCallOfKind(EventualCallKind.EntityCall, a);
}

export type EntityCall<
  Op extends EntityOperation["operation"] = EntityOperation["operation"]
> = EventualCallBase<EventualCallKind.EntityCall> &
  EntityOperation & { operation: Op };

export function isEntityOperationOfType<
  OpType extends EntityOperation["operation"]
>(
  operation: OpType,
  call: EntityOperation
): call is EntityOperation & { operation: OpType } {
  return call.operation === operation;
}

export interface EntityOperationBase {
  name: string;
}

export type EntityOperation =
  | EntityDeleteOperation
  | EntityGetOperation
  | EntityGetWithMetadataOperation
  | EntityListOperation
  | EntityListKeysOperation
  | EntitySetOperation
  | EntityTransactOperation;

export interface EntityGetOperation extends EntityOperationBase {
  operation: "get";
  key: string | CompositeKey;
}

export interface EntityGetWithMetadataOperation extends EntityOperationBase {
  operation: "getWithMetadata";
  key: string | CompositeKey;
}

export interface EntityDeleteOperation extends EntityOperationBase {
  operation: "delete";
  key: string | CompositeKey;
  options?: EntityConsistencyOptions;
}

export interface EntitySetOperation<E = any> extends EntityOperationBase {
  operation: "set";
  key: string | CompositeKey;
  value: E;
  options?: EntitySetOptions;
}

export interface EntityListOperation extends EntityOperationBase {
  operation: "list";
  request: EntityListRequest;
}

export interface EntityListKeysOperation extends EntityOperationBase {
  operation: "listKeys";
  request: EntityListRequest;
}

export interface EntityTransactOperation {
  operation: "transact";
  items: EntityTransactItem<any>[];
}

export function isExpectSignalCall(a: any): a is ExpectSignalCall {
  return isEventualCallOfKind(EventualCallKind.ExpectSignalCall, a);
}

export interface ExpectSignalCall
  extends EventualCallBase<EventualCallKind.ExpectSignalCall> {
  signalId: string;
  timeout?: Promise<any>;
}

export function isSendSignalCall(a: any): a is SendSignalCall {
  return isEventualCallOfKind(EventualCallKind.SendSignalCall, a);
}

export interface SendSignalCall
  extends EventualCallBase<EventualCallKind.SendSignalCall> {
  signalId: string;
  payload?: any;
  target: SignalTarget;
  id?: string;
}

export function isRegisterSignalHandlerCall(
  a: any
): a is RegisterSignalHandlerCall {
  return isEventualCallOfKind(EventualCallKind.RegisterSignalHandlerCall, a);
}

export interface RegisterSignalHandlerCall<T = any>
  extends EventualCallBase<EventualCallKind.RegisterSignalHandlerCall> {
  signalId: string;
  handler: (input: T) => void;
}

export function isTaskCall(a: any): a is TaskCall {
  return isEventualCallOfKind(EventualCallKind.TaskCall, a);
}

export interface TaskCall extends EventualCallBase<EventualCallKind.TaskCall> {
  name: string;
  input: any;
  heartbeat?: DurationSchedule;
  /**
   * Timeout can be any Eventual (promise). When the promise resolves, the task is considered to be timed out.
   */
  timeout?: Promise<any>;
}

export function isChildWorkflowCall(a: EventualCall): a is ChildWorkflowCall {
  return isEventualCallOfKind(EventualCallKind.WorkflowCall, a);
}

/**
 * An {@link Eventual} representing an awaited call to a {@link Workflow}.
 */
export interface ChildWorkflowCall
  extends EventualCallBase<EventualCallKind.WorkflowCall> {
  name: string;
  input?: any;
  opts?: WorkflowExecutionOptions;
  /**
   * An Eventual/Promise that determines when a child workflow should timeout.
   *
   * This timeout is separate from the timeout passed to the workflow (opts.timeout), which can only be a relative duration.
   *
   * TODO: support cancellation of child workflow.
   */
  timeout?: Promise<any>;
}

export function isInvokeTransactionCall(a: any): a is InvokeTransactionCall {
  return isEventualCallOfKind(EventualCallKind.InvokeTransactionCall, a);
}

export interface InvokeTransactionCall<Input = any>
  extends EventualCallBase<EventualCallKind.InvokeTransactionCall> {
  input: Input;
  transactionName: string;
}
