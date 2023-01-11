import { createSendSignalCall } from "./calls/send-signal-call.js";
import { createRegisterSignalHandlerCall } from "./calls/signal-handler-call.js";
import { createExpectSignalCall } from "./calls/expect-signal-call.js";
import { isOrchestratorWorker } from "./runtime/flags.js";
import { getServiceClient } from "./global.js";
import { ulid } from "ulidx";

/**
 * A reference to a created signal handler.
 */
export interface SignalsHandler {
  /**
   * Remove the handler from the signal.
   *
   * Any ongoing {@link Chain}s started by the handler will continue to run to completion.
   */
  dispose: () => void;
}

export type SignalHandlerFunction<Payload = void> = (
  payload: Payload
) => Promise<void> | void;

export function signal<Payload = void>(name: string): Signal<Payload> {
  return new Signal(name);
}

export class Signal<Payload = void> {
  constructor(readonly id: string) {}
  /**
   * Listens for signals sent to the current workflow.
   *
   * When the signal is received, the handler is invoked.
   * If the handler return a promise, the handler is added a {@link Chain}
   * and progressed until completion.
   *
   * ```ts
   * const mySignal = signal("MySignal");
   *
   * workflow("wf", () => {
   *    let done = false;
   *    mySignal.onSignal(async () => {
   *       await sleepFor(10);
   *       done = true;
   *    });
   *
   *    await condition(() => done);
   * });
   * ```
   *
   * To remove the handler, call the dispose method.
   *
   * ```ts
   * const handler = mySignal.onSignal(() => {});
   *
   * await sleepFor(10);
   *
   * handler.dispose();
   * ```
   */
  public onSignal(handler: SignalHandlerFunction<Payload>): SignalsHandler {
    return onSignal(this, handler);
  }

  /**
   * Waits for a signal to be received by the workflow.
   *
   * The first signal received will resolve the Promise with the payload of the promise.
   *
   * ```ts
   * const mySignal = signal<string>("MySignal");
   * workflow("wf", async () => {
   *    const payload = await mySignal.expectSignal();
   *
   *    return payload;
   * });
   * ```
   *
   * Use `opts.timeoutSeconds` to stop waiting after the provided time. The Promise will reject
   * when the provided time has elapsed.
   *
   * ```ts
   * const mySignal = signal<string>("MySignal");
   * workflow("wf", async () => {
   *    try {
   *       const payload = await mySignal.expectSignal({ timeoutSecond: 10 * 60 });
   *
   *       return payload;
   *    } catch {
   *       return "nothing!";
   *    }
   * });
   * ```
   */
  public expectSignal(opts?: ExpectSignalOptions): Promise<Payload> {
    return expectSignal(this, opts);
  }

  /**
   * Allows a {@link workflow} to send this signal to any workflow {@link Execution} by executionId.
   *
   * ```ts
   * const mySignal = signal<string>("MySignal");
   * workflow("wf", async () => {
   *    mySignal.sendSignal("payload");
   * })
   * ```
   */
  public sendSignal(
    executionId: string,
    ...args: SendSignalProps<Payload>
  ): Promise<void> {
    return sendSignal(executionId, this, ...args);
  }
}

export type SignalPayload<E extends Signal<any>> = E extends Signal<infer P>
  ? P
  : never;

export interface ExpectSignalOptions {
  /**
   * Optional. Seconds to wait for the signal to be received.
   *
   * After the provided seconds, the promise will reject.
   */
  timeoutSeconds: number;
}

/**
 * Waits for a signal to be received by the workflow.
 *
 * The first signal received will resolve the Promise with the payload of the promise.
 *
 * ```ts
 * workflow("wf", () => {
 *    const payload = await expectSignal("MySignal");
 *
 *    return payload;
 * });
 * ```
 *
 * Use `opts.timeoutSeconds` to stop waiting after the provided time. The Promise will reject
 * when the provided time has elapsed.
 */
export function expectSignal<SignalPayload = any>(
  signal: Signal<SignalPayload> | string,
  opts?: ExpectSignalOptions
): Promise<SignalPayload> {
  if (!isOrchestratorWorker()) {
    throw new Error("expectSignal is only valid in a workflow");
  }

  return createExpectSignalCall(
    typeof signal === "string" ? signal : signal.id,
    opts?.timeoutSeconds
  ) as any;
}

/**
 * Listens for a signal matching the signalId provided.
 *
 * When the signal is received, the handler is invoked.
 * If the handler return a promise, the handler is added as a {@link Chain}
 * and progressed until completion.
 *
 * ```ts
 * workflow("wf", () => {
 *    let done = false;
 *    onSignal("MySignal", async () => {
 *       await sleepFor(10);
 *       done = true;
 *    });
 *
 *    await condition(() => done);
 * });
 * ```
 *
 * To remove the handler, call the dispose method.
 *
 * ```ts
 * const handler = onSignal("MySignal", () => {});
 *
 * await sleepFor(10);
 *
 * handler.dispose();
 * ```
 */
export function onSignal<Payload>(
  signal: Signal<Payload> | string,
  handler: SignalHandlerFunction<Payload>
): SignalsHandler {
  if (!isOrchestratorWorker()) {
    throw new Error("onSignal is only valid in a workflow");
  }

  return createRegisterSignalHandlerCall(
    typeof signal === "string" ? signal : signal.id,
    handler as any
  );
}

export type SendSignalProps<SignalPayload> = [SignalPayload] extends
  | [undefined]
  | [void]
  ? []
  : [payload: SignalPayload];

/**
 * Allows a {@link workflow} to send a signal to any workflow {@link Execution} by executionId.
 *
 * ```ts
 * const mySignal = signal<string>("MySignal");
 * workflow("wf", async () => {
 *    sendSignal("mySignal", "payload");
 *    sendSignal(mySignal, "payload");
 * })
 * ```
 *
 * @param id an optional, execution unique ID, will be used to de-dupe the signal at the target execution.
 */
export function sendSignal<Payload = any>(
  executionId: string,
  signal: string | Signal<Payload>,
  ...args: SendSignalProps<Payload>
): Promise<void> {
  const [payload] = args;
  if (isOrchestratorWorker()) {
    return createSendSignalCall(
      { type: SignalTargetType.Execution, executionId },
      typeof signal === "string" ? signal : signal.id,
      payload
    ) as unknown as any;
  } else {
    return getServiceClient().sendSignal({
      execution: executionId,
      signal,
      id: ulid(),
      payload,
    });
  }
}

export type SignalTarget = ExecutionTarget | ChildExecutionTarget;

export enum SignalTargetType {
  Execution,
  ChildExecution,
}

export interface ExecutionTarget {
  type: SignalTargetType.Execution;
  executionId: string;
}

export interface ChildExecutionTarget {
  type: SignalTargetType.ChildExecution;
  workflowName: string;
  seq: number;
}

export function isChildExecutionTarget(
  target: SignalTarget
): target is ChildExecutionTarget {
  return target.type === SignalTargetType.ChildExecution;
}

export function isExecutionTarget(
  target: SignalTarget
): target is ExecutionTarget {
  return target.type === SignalTargetType.Execution;
}
