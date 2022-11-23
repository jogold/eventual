import { App, aws_dynamodb, Stack } from "aws-cdk-lib";
import * as eventual from "@eventual/aws-cdk";

const app = new App();

const stack = new Stack(app, "test-eventual-sam");

const accountTable = new aws_dynamodb.Table(stack, "Accounts", {
  partitionKey: {
    name: "pk",
    type: aws_dynamodb.AttributeType.STRING,
  },
  billingMode: aws_dynamodb.BillingMode.PAY_PER_REQUEST,
});

const openAccount = new eventual.Service(stack, "OpenAccount", {
  entry: require.resolve("test-app-runtime/lib/open-account.js"),
  name: "open-account",
  environment: {
    TABLE_NAME: accountTable.tableName,
  },
});

accountTable.grantReadWriteData(openAccount);

const myWorkflow = new eventual.Service(stack, "workflow1", {
  name: "my-workflow",
  entry: require.resolve("test-app-runtime/lib/my-workflow.js"),
});

new eventual.EventualApi(stack, "api", {
  services: [myWorkflow, openAccount],
});
