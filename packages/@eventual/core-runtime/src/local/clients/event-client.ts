import { EventEnvelope } from "@eventual/core";
import { EventClient } from "../../clients/event-client.js";
import { SubscriptionWorker } from "../../handlers/subscription-worker.js";

export class LocalEventClient implements EventClient {
  constructor(private eventHandlerWorker: SubscriptionWorker) {}

  public async emitEvents(...event: EventEnvelope[]): Promise<void> {
    return await this.eventHandlerWorker(event);
  }
}
