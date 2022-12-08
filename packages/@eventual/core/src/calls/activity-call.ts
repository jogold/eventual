import {
  isEventual,
  EventualSymbol,
  EventualKind,
  EventualBase,
} from "../eventual.js";
import { registerEventual } from "../global.js";
import { Resolved, Failed } from "../result.js";

export function isActivityCall(a: any): a is ActivityCall {
  return isEventual(a) && a[EventualSymbol] === EventualKind.ActivityCall;
}

export interface ActivityCall<T = any>
  extends EventualBase<Resolved<T> | Failed> {
  [EventualSymbol]: EventualKind.ActivityCall;
  seq?: number;
  name: string;
  args: any[];
  timeoutSeconds?: number;
}

export function createActivityCall(name: string, args: any[], timeoutSeconds?: number): ActivityCall {
  const command: ActivityCall = {
    [EventualSymbol]: EventualKind.ActivityCall,
    name,
    args,
    timeoutSeconds,
  };
  return registerEventual<ActivityCall>(command);
}
