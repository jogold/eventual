import { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import useWebSocket from "react-use-websocket";
import {
  isInitMessage,
  isReportProgressMessage,
  ProgressState,
} from "../messages.js";
import { ProgressBar } from "react-bootstrap";

// [WEBSOCKETURL] will be replaced at deployment time.
const websocketUrl = "[WEBSOCKETURL]";

const App = () => {
  // TODO, make dynamic
  const { lastJsonMessage, readyState, sendJsonMessage } =
    useWebSocket.default(websocketUrl);

  const startWorkflow = useCallback(() => sendJsonMessage({}), []);
  const [progresses, setProgresses] = useState<
    Record<string, ProgressState> | undefined
  >();

  useEffect(() => {
    if (lastJsonMessage !== null) {
      setProgresses((s) => {
        if (isInitMessage(lastJsonMessage)) {
          return Object.fromEntries(
            lastJsonMessage.progresses.map((p) => [p.id, p])
          );
        } else if (isReportProgressMessage(lastJsonMessage)) {
          return {
            ...s,
            [lastJsonMessage.progress.id]: lastJsonMessage.progress,
          };
        }
        return s;
      });
    }
  }, [lastJsonMessage]);

  useEffect(() => {
    console.log(readyState);
  }, [readyState]);

  return (
    <div>
      <button onClick={startWorkflow}>click me</button>
      {progresses ? (
        <div>
          {Object.values(progresses)
            .reverse()
            .map((s) => (
              <div id={s.id}>
                {s.id}:
                <ProgressBar
                  variant={s.done ? "success" : undefined}
                  animated={!s.done}
                  now={((s.value * 1.0) / s.goal) * 100}
                />
              </div>
            ))}
        </div>
      ) : null}
    </div>
  );
};

const root = ReactDOM.createRoot(document.querySelector("#container")!);
root.render(<App />);
