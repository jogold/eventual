export const sampleServiceCode = `import { event, task, workflow, command, HttpResponse } from "@eventual/core";

export const work = command("work", async (items: string[]) => {
  const { executionId } = await myWorkflow.startExecution({
    input: items,
  });
  
  return { executionId };
});

export const myWorkflow = workflow("myWorkflow", async (items: string[]) => {
  const results = await Promise.all(items.map(doWork));

  await workDone.emit({
    outputs: results,
  });

  return results;
});

export const doWork = task("work", async (work: string) => {
  console.log("Doing Work", work);

  return work.length;
});

export interface WorkDoneEvent {
  outputs: number[];
}

export const workDone = event<WorkDoneEvent>("WorkDone");
`;

export function sampleSSTCode(projectName: string) {
  return `import { StackContext } from "@serverless-stack/resources";
import { Service } from "@eventual/aws-cdk";
import path from "path";
import url from "url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

export function MyStack({ stack }: StackContext) {
  const service = new Service(stack, "Service", {
    // this path is relative to .build/ where SST puts the CDK bundle
    entry: path.resolve(__dirname, "..", "..", "services", "functions", "service.ts"),
    name: "${projectName}",
  });
  stack.addOutputs({
    ServiceApiEndpoint: service.gateway.url!,
    ServiceEventBusArn: service.bus.eventBusArn
  });
}
`;
}

export function sampleCDKApp(serviceName: string) {
  const servicePackageName = `@${serviceName}/service`;
  const serviceReferenceName = serviceName.replace(/[^A-Za-z0-9_]*/g, "");

  return `import { App, Stack, CfnOutput } from "aws-cdk-lib";
import { Service } from "@eventual/aws-cdk";

const app = new App();
const stack = new Stack(app, "${serviceName}")

import type * as ${serviceReferenceName} from "${servicePackageName}"

const service = new Service<typeof ${serviceReferenceName}>(stack, "Service", {
  name: "${serviceName}",
  entry: require.resolve("${servicePackageName}")
});
`;
}
