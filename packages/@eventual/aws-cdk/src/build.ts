import { build, BuildSource, infer } from "@eventual/compiler";
import { BuildManifest } from "@eventual/core-runtime";
import {
  CommandSpec,
  EntityStreamSpec,
  EVENTUAL_SYSTEM_COMMAND_NAMESPACE,
  ServiceType,
  SubscriptionSpec,
  TaskSpec,
} from "@eventual/core/internal";
import { Code } from "aws-cdk-lib/aws-lambda";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

export interface BuildOutput extends BuildManifest {}

export class BuildOutput {
  // ensure that only one Asset is created per file even if that file is packaged multiple times
  private codeAssetCache: {
    [file: string]: Code;
  } = {};

  constructor(
    readonly serviceName: string,
    readonly outDir: string,
    manifest: BuildManifest
  ) {
    Object.assign(this, manifest);
  }

  public getCode(file: string) {
    return (this.codeAssetCache[file] ??= Code.fromAsset(
      this.resolveFolder(file)
    ));
  }

  public resolveFolder(file: string) {
    return path.dirname(path.resolve(this.outDir, file));
  }
}

export function buildServiceSync(request: BuildAWSRuntimeProps): BuildOutput {
  execSync(
    `node ${require.resolve("./build-cli.js")} ${Buffer.from(
      JSON.stringify(request)
    ).toString("base64")}`
  );

  return new BuildOutput(
    request.serviceName,
    path.resolve(request.outDir),
    JSON.parse(
      fs
        .readFileSync(path.join(request.outDir, "manifest.json"))
        .toString("utf-8")
    )
  );
}

export interface BuildAWSRuntimeProps {
  serviceName: string;
  entry: string;
  outDir: string;
}

export async function buildService(request: BuildAWSRuntimeProps) {
  const outDir = request.outDir;
  const serviceSpec = await infer(request.entry);

  const specPath = path.join(outDir, "spec.json");
  await fs.promises.mkdir(path.dirname(specPath), { recursive: true });
  // just data extracted from the service, used by the handlers
  // separate from the manifest to avoid circular dependency with the bundles
  // and reduce size of the data injected into the bundles
  await fs.promises.writeFile(specPath, JSON.stringify(serviceSpec, null, 2));

  const [
    [
      // bundle the default handlers first as we refer to them when bundling all of the individual handlers
      orchestrator,
      monoTaskFunction,
      monoCommandFunction,
      monoSubscriptionFunction,
      monoEntityStreamWorkerFunction,
      transactionWorkerFunction,
    ],
    [
      // also bundle each of the internal eventual API Functions as they have no dependencies
      taskFallbackHandler,
      scheduleForwarder,
      timerHandler,
    ],
  ] = await Promise.all([
    bundleMonolithDefaultHandlers(specPath),
    bundleEventualSystemFunctions(specPath),
  ]);

  // then, bundle each of the commands and subscriptions
  const [commands, subscriptions, tasks] = await Promise.all([
    bundleCommands(serviceSpec.commands),
    bundleSubscriptions(serviceSpec.subscriptions),
    bundleTasks(serviceSpec.tasks),
  ] as const);

  const manifest: BuildManifest = {
    serviceName: request.serviceName,
    entry: request.entry,
    tasks: tasks,
    events: serviceSpec.events,
    subscriptions,
    commands: commands,
    commandDefault: {
      entry: monoCommandFunction!,
      spec: {
        name: "default",
      },
    },
    entities: {
      entities: await Promise.all(
        serviceSpec.entities.entities.map(async (d) => ({
          ...d,
          streams: await bundleEntityStreams(d.streams),
        }))
      ),
      transactions: serviceSpec.transactions,
    },
    system: {
      entityService: {
        transactionWorker: { entry: transactionWorkerFunction! },
      },
      taskService: {
        fallbackHandler: { entry: taskFallbackHandler! },
      },
      eventualService: {
        systemCommandHandler: {
          entry: await buildFunction({
            entry: runtimeHandlersEntrypoint("system-command-handler"),
            name: "systemDefault",
            injectedEntry: request.entry,
            injectedServiceSpec: specPath,
          }),
        },
        commands: [
          "listWorkflows",
          "startExecution",
          "listExecutions",
          "getExecution",
          "getExecutionHistory",
          "sendSignal",
          "getExecutionWorkflowHistory",
          "emitEvents",
          "updateTask",
          "executeTransaction",
        ].map((name) => ({
          name,
          namespace: EVENTUAL_SYSTEM_COMMAND_NAMESPACE,
        })),
      },
      schedulerService: {
        forwarder: {
          entry: scheduleForwarder!,
          handler: "index.handle",
        },
        timerHandler: {
          entry: timerHandler!,
          handler: "index.handle",
        },
      },
      workflowService: {
        orchestrator: {
          entry: orchestrator!,
        },
      },
    },
  };

  await fs.promises.writeFile(
    path.join(outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );

  async function bundleCommands(commandSpecs: CommandSpec[]) {
    return await Promise.all(
      commandSpecs.map(async (spec) => {
        return {
          entry: await bundleFile(
            specPath,
            spec,
            "command",
            "command-worker",
            spec.name,
            monoCommandFunction!
          ),
          spec,
        };
      })
    );
  }

  async function bundleSubscriptions(specs: SubscriptionSpec[]) {
    return await Promise.all(
      specs.map(async (spec) => {
        return {
          entry: await bundleFile(
            specPath,
            spec,
            "subscription",
            "subscription-worker",
            spec.name,
            monoSubscriptionFunction!
          ),
          spec,
        };
      })
    );
  }

  async function bundleTasks(specs: TaskSpec[]) {
    return await Promise.all(
      specs.map(async (spec) => {
        return {
          entry: await bundleFile(
            specPath,
            spec,
            "task",
            "task-worker",
            spec.name,
            monoTaskFunction!
          ),
          spec,
        };
      })
    );
  }

  async function bundleEntityStreams(specs: EntityStreamSpec[]) {
    return await Promise.all(
      specs.map(async (spec) => {
        return {
          entry: await bundleFile(
            specPath,
            spec,
            "entity-streams",
            "entity-stream-worker",
            spec.name,
            monoEntityStreamWorkerFunction!
          ),
          spec,
        };
      })
    );
  }

  async function bundleFile<
    Spec extends CommandSpec | SubscriptionSpec | TaskSpec
  >(
    specPath: string,
    spec: Spec,
    pathPrefix: string,
    entryPoint: string,
    name: string,
    monoFunction: string
  ): Promise<string> {
    return spec.sourceLocation?.fileName
      ? // we know the source location of the command, so individually build it from that
        // file and create a separate (optimized bundle) for it
        // TODO: generate an index.ts that imports { exportName } from "./sourceLocation" for enhanced bundling
        // TODO: consider always bundling from the root index.ts instead of arbitrarily via ESBuild+SWC AST transformer
        await buildFunction({
          name: path.join(pathPrefix, name),
          entry: runtimeHandlersEntrypoint(entryPoint),
          exportName: spec.sourceLocation.exportName,
          injectedEntry: spec.sourceLocation.fileName,
          injectedServiceSpec: specPath,
        })
      : monoFunction;
  }

  function bundleMonolithDefaultHandlers(specPath: string) {
    return Promise.all(
      [
        {
          name: ServiceType.OrchestratorWorker,
          entry: runtimeHandlersEntrypoint("orchestrator"),
        },
        {
          name: ServiceType.TaskWorker,
          entry: runtimeHandlersEntrypoint("task-worker"),
        },
        {
          name: ServiceType.CommandWorker,
          entry: runtimeHandlersEntrypoint("command-worker"),
        },
        {
          name: ServiceType.Subscription,
          entry: runtimeHandlersEntrypoint("subscription-worker"),
        },
        {
          name: ServiceType.EntityStreamWorker,
          entry: runtimeHandlersEntrypoint("entity-stream-worker"),
        },
        {
          name: ServiceType.TransactionWorker,
          entry: runtimeHandlersEntrypoint("transaction-worker"),
        },
      ]
        .map((s) => ({
          ...s,
          injectedEntry: request.entry,
          injectedServiceSpec: specPath,
        }))
        .map(buildFunction)
    );
  }

  function bundleEventualSystemFunctions(specPath: string) {
    return Promise.all(
      (
        [
          {
            name: "TaskFallbackHandler",
            entry: runtimeHandlersEntrypoint("task-fallback-handler"),
          },
          {
            name: "SchedulerForwarder",
            entry: runtimeHandlersEntrypoint("schedule-forwarder"),
          },
          {
            name: "SchedulerHandler",
            entry: runtimeHandlersEntrypoint("timer-handler"),
          },
        ] satisfies Omit<
          BuildSource,
          "outDir" | "injectedEntry" | "injectedServiceSpec"
        >[]
      )
        .map((s) => ({
          ...s,
          injectedEntry: request.entry,
          injectedServiceSpec: specPath,
        }))
        .map(buildFunction)
    );
  }

  async function buildFunction(input: Omit<BuildSource, "outDir">) {
    const file = await build({
      ...input,
      outDir: request.outDir,
    });
    return path.relative(path.resolve(request.outDir), path.resolve(file));
  }
}

function runtimeHandlersEntrypoint(name: string) {
  return path.join(runtimeEntrypoint(), `/handlers/${name}.js`);
}

function runtimeEntrypoint() {
  return path.join(require.resolve("@eventual/aws-runtime"), `../../esm`);
}
