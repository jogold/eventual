import { EventualServiceClient, HttpMethod, HttpRequest } from "@eventual/core";
import type { CommandWorker } from "@eventual/core-runtime";
import { registerServiceClient } from "@eventual/core/internal";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { Buffer } from "buffer";

/**
 * Handle inbound webhook API requests.
 *
 * Each webhook registers routes on the central router that
 * then handles the request.
 */
export function createApiGCommandAdaptor({
  commandWorker,
  serviceClientBuilder,
}: {
  commandWorker: CommandWorker;
  serviceClientBuilder?: (serviceUrl: string) => EventualServiceClient;
}): APIGatewayProxyHandlerV2 {
  return async function (
    event: APIGatewayProxyEventV2
  ): Promise<APIGatewayProxyResultV2> {
    console.debug("event", event);
    //
    if (serviceClientBuilder) {
      registerServiceClient(
        serviceClientBuilder(`https://${event.requestContext.domainName}`)
      );
    }
    const requestBody = event.body
      ? event.isBase64Encoded
        ? Buffer.from(event.body, "base64")
        : event.body
      : undefined;

    const request = new HttpRequest(
      `https://${event.requestContext.domainName}${event.rawPath}?${event.rawQueryString}`,
      {
        // TODO: get protocol from header 'x-forwarded-proto'?
        body: requestBody,
        headers: event.headers as Record<string, string>,
        method: event.requestContext.http.method as HttpMethod,
      }
    );

    const response = await commandWorker(request);
    const headers: Record<string, string> = {};

    response.headers.forEach((value, key) => (headers[key] = value));

    let responseBody: Buffer;
    if (typeof response.body === "string") {
      responseBody = Buffer.from(response.body, "utf-8");
    } else if (Buffer.isBuffer(response.body)) {
      responseBody = response.body;
    } else if (typeof response.arrayBuffer === "function") {
      responseBody = Buffer.from(await response.arrayBuffer());
    } else if (typeof response.text === "function") {
      responseBody = Buffer.from(await response.text(), "utf-8");
    } else {
      throw new Error(`Unrecognized body type: ${typeof response.body}`);
    }
    const httpResponse = {
      headers,
      statusCode: response.status,
      body: responseBody.toString("base64"),
      isBase64Encoded: true,
    };
    console.debug("httpResponse", httpResponse);
    return httpResponse;
  };
}
