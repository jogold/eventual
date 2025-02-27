import { IHttpApi } from "@aws-cdk/aws-apigatewayv2-alpha";
import { ENV_NAMES } from "@eventual/aws-runtime";
import { Event } from "@eventual/core";
import { MetricsCommon, OrchestratorMetrics } from "@eventual/core-runtime";
import { EventualConfig, discoverEventualConfigSync } from "@eventual/project";
import { Arn, Names, Stack, aws_events, aws_events_targets } from "aws-cdk-lib";
import {
  Metric,
  MetricOptions,
  Statistic,
  Unit,
} from "aws-cdk-lib/aws-cloudwatch";
import { IEventBus } from "aws-cdk-lib/aws-events";
import {
  AccountRootPrincipal,
  Effect,
  IGrantable,
  IPrincipal,
  PolicyStatement,
  Role,
  UnknownPrincipal,
} from "aws-cdk-lib/aws-iam";
import { Function } from "aws-cdk-lib/aws-lambda";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import openapi from "openapi3-ts";
import path from "path";
import { BuildOutput, buildServiceSync } from "./build";
import {
  CommandProps,
  CommandService,
  Commands,
  CorsOptions,
} from "./command-service";
import { DeepCompositePrincipal } from "./deep-composite-principal.js";
import {
  EntityService,
  EntityServiceProps,
  EntityStream,
  EntityStreamOverrides,
  ServiceEntities,
  ServiceEntityStreams,
} from "./entity-service.js";
import { EventService } from "./event-service";
import { grant } from "./grant";
import { LazyInterface, lazyInterface } from "./proxy-construct";
import { SchedulerService } from "./scheduler-service";
import {
  Subscription,
  SubscriptionOverrides,
  Subscriptions,
} from "./subscriptions";
import {
  ServiceTasks,
  Task,
  TaskOverrides,
  TaskService,
} from "./task-service.js";
import { WorkflowService, WorkflowServiceOverrides } from "./workflow-service";

/**
 * The properties for subscribing a Service to another Service's events.
 *
 * @see Service.subscribe
 */
export interface SubscribeProps extends aws_events_targets.EventBusProps {
  /**
   * The {@link Service} to subscribe to.
   */
  service: Service;
  /**
   * The events to subscribe to. Can specify a string or a reference to an {@link Event}.
   */
  events: (Event | string)[];
}

export interface ServiceProps<Service = any> {
  /**
   * Provide an explicit {@link EventualConfig} file or a path to the directory containing the eventual.json file.
   *
   * When not provided eventual will look for eventual.json file at the current working directory or up to two directories above.
   *
   * If the config file is not found or invalid, the synthesis will fail.
   */
  eventualConfig?: string | EventualConfig;
  /**
   * The path of the `.ts` or `.js` file that is the entrypoint to the Service's logic.
   */
  entry: string;
  /**
   * Name of the {@link Service}. This is the name that will be
   *
   * @default - the {@link Service}'s {@link Construct.node} address.
   */
  name?: string;
  /**
   * Environment variables to include in all API, Event and Task handler Functions.
   */
  environment?: {
    [key: string]: string;
  };
  /**
   * Override Properties of the Task handlers within the service.
   */
  tasks?: TaskOverrides<Service>;
  /**
   * Override properties of Command Functions within the Service.
   */
  commands?: CommandProps<Service>;
  /**
   * Override properties of Subscription Functions within the Service.
   */
  subscriptions?: SubscriptionOverrides<Service>;
  entityStreamOverrides?: EntityStreamOverrides<Service>;
  cors?: CorsOptions;
  system?: {
    /**
     * Configuration properties for the workflow orchestrator
     */
    workflowService?: WorkflowServiceOverrides;
    entityService?: EntityServiceProps<Service>["entityServiceOverrides"];
  };
}

export interface LoggingProps {}

export interface ServiceSystem<S> {
  /**
   * The subsystem that controls workflows.
   */
  readonly workflowService: WorkflowService;
  readonly taskService: TaskService<S>;
  /**`
   * The subsystem for schedules and timers.
   */
  readonly schedulerService: SchedulerService;
  readonly entityService: EntityService<S>;
  /**
   * The {@link AppSec} inferred from the application code.
   */
  readonly build: BuildOutput;
  readonly systemCommandsHandler: Function;
  /**
   * A SSM parameter containing data about this service.
   */
  readonly serviceMetadataSSM: StringParameter;
  /**
   * Role used by the CLI and Local Environment.
   */
  readonly accessRole: Role;
}

export interface ServiceLocal {
  readonly environmentRole: Role;
}

export class Service<S = any> extends Construct {
  /**
   * The subsystem that controls tasks.
   */
  public readonly tasks: ServiceTasks<S>;
  /**
   * Bus which transports events in and out of the service.
   */
  public readonly bus: IEventBus;
  /**
   * Commands defined by the service.
   */
  public readonly commands: Commands<S>;
  /**
   * TODO
   */
  public readonly entities: ServiceEntities<S>;
  public readonly entityStreams: ServiceEntityStreams<S>;
  /**
   * API Gateway which serves the service commands and the system commands.
   */
  public readonly gateway: IHttpApi;
  /**
   * Name of this Service.
   */
  public readonly serviceName: string;
  /**
   * This {@link Service}'s API Gateway.
   */
  public readonly specification: openapi.OpenAPIObject;
  /**
   * The Subscriptions within this Service.
   */
  public readonly subscriptions: Subscriptions<S>;
  /**
   * Log group which workflow executions write to.
   */
  public readonly workflowLogGroup: LogGroup;

  private readonly eventService: EventService;
  private readonly commandService: CommandService<S>;

  public grantPrincipal: IPrincipal;
  public commandsPrincipal: IPrincipal;
  public tasksPrincipal: IPrincipal;
  public subscriptionsPrincipal: IPrincipal;
  public entityStreamPrincipal: IPrincipal;

  public readonly system: ServiceSystem<S>;

  /**
   * When present, local mode is enabled.
   *
   * Enable local mode by setting environment variable EVENTUAL_LOCAL=1 in deployment environment.
   */
  public readonly local?: ServiceLocal;

  constructor(scope: Construct, id: string, props: ServiceProps<S>) {
    super(scope, id);

    const eventualConfig = props.eventualConfig
      ? typeof props.eventualConfig === "string"
        ? discoverEventualConfigSync(props.eventualConfig, 0)
        : props.eventualConfig
      : discoverEventualConfigSync();

    if (!eventualConfig) {
      throw new Error(
        "Could not find an eventual config file (eventual.json)."
      );
    }

    this.serviceName = props.name ?? Names.uniqueResourceName(this, {});

    const serviceScope = this;
    const systemScope = new Construct(this, "System");
    const eventualServiceScope = new Construct(systemScope, "EventualService");

    const accessRole = new Role(eventualServiceScope, "AccessRole", {
      roleName: `eventual-cli-${this.serviceName}`,
      assumedBy: new AccountRootPrincipal(),
    });

    this.local = !!process.env.EVENTUAL_LOCAL
      ? {
          environmentRole: accessRole,
        }
      : undefined;

    const build = buildServiceSync({
      serviceName: this.serviceName,
      entry: props.entry,
      outDir: path.join(eventualConfig.outDir, ".eventual", this.serviceName),
    });

    const proxySchedulerService = lazyInterface<SchedulerService>();
    const proxyWorkflowService = lazyInterface<WorkflowService>();
    const proxyTaskService = lazyInterface<TaskService<S>>();
    const proxyService = lazyInterface<Service<S>>();
    const proxyCommandService = lazyInterface<CommandService<S>>();

    const serviceConstructProps: ServiceConstructProps = {
      build,
      environment: props.environment,
      service: proxyService,
      serviceName: this.serviceName,
      serviceScope,
      systemScope,
      eventualServiceScope,
    };

    this.eventService = new EventService(serviceConstructProps);
    this.bus = this.eventService.bus;

    const entityService = new EntityService<S>({
      commandService: proxyCommandService,
      entityStreamOverrides: props.entityStreamOverrides,
      entityServiceOverrides: props.system?.entityService,
      eventService: this.eventService,
      workflowService: proxyWorkflowService,
      ...serviceConstructProps,
    });
    this.entities = entityService.entities;
    this.entityStreams = entityService.entityStreams;

    const taskService = new TaskService<S>({
      ...serviceConstructProps,
      schedulerService: proxySchedulerService,
      workflowService: proxyWorkflowService,
      commandsService: proxyCommandService,
      overrides: props.tasks,
      local: this.local,
      entityService,
    });
    proxyTaskService._bind(taskService);
    this.tasks = taskService.tasks;

    const workflowService = new WorkflowService({
      taskService: taskService,
      eventService: this.eventService,
      schedulerService: proxySchedulerService,
      overrides: props.system?.workflowService,
      entityService,
      ...serviceConstructProps,
    });
    proxyWorkflowService._bind(workflowService);
    this.workflowLogGroup = workflowService.logGroup;

    const scheduler = new SchedulerService({
      taskService: taskService,
      workflowService: workflowService,
      ...serviceConstructProps,
    });
    proxySchedulerService._bind(scheduler);

    this.commandService = new CommandService({
      taskService: taskService,
      overrides: props.commands,
      eventService: this.eventService,
      workflowService: workflowService,
      cors: props.cors,
      local: this.local,
      entityService,
      ...serviceConstructProps,
    });
    proxyCommandService._bind(this.commandService);
    this.commands = this.commandService.serviceCommands;
    this.gateway = this.commandService.gateway;
    this.specification = this.commandService.specification;

    this.subscriptions = new Subscriptions({
      commandService: this.commandService,
      eventService: this.eventService,
      subscriptions: props.subscriptions,
      local: this.local,
      entityService,
      ...serviceConstructProps,
    });

    this.commandService.grantInvokeHttpServiceApi(accessRole);
    workflowService.grantFilterLogEvents(accessRole);

    // service metadata
    const serviceDataSSM = new StringParameter(
      eventualServiceScope,
      "ServiceMetadata",
      {
        parameterName: `/eventual/services/${this.serviceName}`,
        stringValue: JSON.stringify({
          apiEndpoint: this.commandService.gateway.apiEndpoint,
          eventBusArn: this.bus.eventBusArn,
          workflowExecutionLogGroupName: workflowService.logGroup.logGroupName,
          environmentVariables: props.environment,
        }),
      }
    );

    this.commandsPrincipal =
      this.commandsList.length > 0 || this.local
        ? new DeepCompositePrincipal(
            ...(this.local ? [this.local.environmentRole] : []),
            ...this.commandsList.map((f) => f.grantPrincipal)
          )
        : new UnknownPrincipal({ resource: this });
    this.tasksPrincipal =
      this.tasksList.length > 0 || this.local
        ? new DeepCompositePrincipal(
            ...(this.local ? [this.local.environmentRole] : []),
            ...this.tasksList.map((f) => f.grantPrincipal)
          )
        : new UnknownPrincipal({ resource: this });
    this.subscriptionsPrincipal =
      this.subscriptionsList.length > 0 || this.local
        ? new DeepCompositePrincipal(
            ...(this.local ? [this.local.environmentRole] : []),
            ...this.subscriptionsList.map((f) => f.grantPrincipal)
          )
        : new UnknownPrincipal({ resource: this });
    this.entityStreamPrincipal =
      this.entityStreamList.length > 0 || this.local
        ? new DeepCompositePrincipal(
            ...(this.local ? [this.local.environmentRole] : []),
            ...this.entityStreamList.map((f) => f.grantPrincipal)
          )
        : new UnknownPrincipal({ resource: this });
    this.grantPrincipal = new DeepCompositePrincipal(
      this.commandsPrincipal,
      this.tasksPrincipal,
      this.subscriptionsPrincipal,
      this.entityStreamPrincipal
    );

    serviceDataSSM.grantRead(accessRole);
    this.system = {
      accessRole: accessRole,
      taskService,
      build,
      entityService,
      schedulerService: scheduler,
      systemCommandsHandler: this.commandService.systemCommandsHandler,
      serviceMetadataSSM: serviceDataSSM,
      workflowService,
    };
    proxyService._bind(this);
  }

  public get tasksList(): Task[] {
    return Object.values(this.tasks);
  }

  public get commandsList(): EventualResource[] {
    return Object.values(this.commands);
  }

  public get subscriptionsList(): Subscription[] {
    return Object.values(this.subscriptions);
  }

  public get entityStreamList(): EntityStream[] {
    return Object.values(this.entityStreams);
  }

  public subscribe(
    scope: Construct,
    id: string,
    props: SubscribeProps
  ): aws_events.Rule {
    return new aws_events.Rule(scope, id, {
      eventBus: props.service.bus,
      eventPattern: {
        detailType: props.events.map((event) =>
          typeof event === "string" ? event : event.name
        ),
      },
      targets: [new aws_events_targets.EventBus(this.bus)],
    });
  }

  /**
   * Add an environment variable to the Task, API, Event and Workflow handler Functions.
   *
   * @param key The environment variable key.
   * @param value The environment variable's value.
   */
  public addEnvironment(key: string, value: string): void {
    this.tasksList.forEach(({ handler }) => handler.addEnvironment(key, value));
    this.commandsList.forEach(({ handler }) =>
      handler.addEnvironment(key, value)
    );
    this.subscriptionsList.forEach(({ handler }) =>
      handler.addEnvironment(key, value)
    );
    this.system.workflowService.orchestrator.addEnvironment(key, value);
  }

  /**
   * Service Client
   */

  public configureStartExecution(func: Function) {
    this.system.workflowService.configureStartExecution(func);
  }

  @grant()
  public grantStartExecution(grantable: IGrantable) {
    this.system.workflowService.grantStartExecution(grantable);
  }

  public configureReadExecutions(func: Function) {
    this.system.workflowService.configureReadExecutions(func);
    this.system.workflowService.configureReadExecutionHistory(func);
    this.system.workflowService.configureReadHistoryState(func);
  }
  @grant()
  public grantReadExecutions(grantable: IGrantable) {
    this.system.workflowService.grantReadExecutions(grantable);
  }

  public configureSendSignal(func: Function) {
    this.system.workflowService.configureSendSignal(func);
  }

  @grant()
  public grantSendSignal(grantable: IGrantable) {
    this.system.workflowService.grantSendSignal(grantable);
  }

  public configureEmitEvents(func: Function) {
    this.eventService.configureEmit(func);
  }

  @grant()
  public grantEmitEvents(grantable: IGrantable) {
    this.eventService.grantEmit(grantable);
  }

  @grant()
  public grantInvokeHttpServiceApi(grantable: IGrantable) {
    this.commandService.grantInvokeHttpServiceApi(grantable);
  }

  public configureUpdateTask(func: Function) {
    // complete tasks
    this.system.taskService.configureCompleteTask(func);
    // cancel
    this.system.taskService.configureWriteTasks(func);
    // heartbeat
    this.system.taskService.configureSendHeartbeat(func);
  }

  public configureForServiceClient(func: Function) {
    this.configureUpdateTask(func);
    this.configureEmitEvents(func);
    this.configureReadExecutions(func);
    this.configureSendSignal(func);
    this.configureStartExecution(func);
  }

  public configureServiceName(func: Function) {
    this.addEnvs(func, ENV_NAMES.SERVICE_NAME);
  }

  private readonly ENV_MAPPINGS = {
    [ENV_NAMES.SERVICE_NAME]: () => this.serviceName,
  } as const;

  private addEnvs(func: Function, ...envs: (keyof typeof this.ENV_MAPPINGS)[]) {
    envs.forEach((env) => func.addEnvironment(env, this.ENV_MAPPINGS[env]()));
  }

  /**
   * Allow a client to list services from ssm
   */
  public static grantDescribeParameters(stack: Stack, grantable: IGrantable) {
    grantable.grantPrincipal.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ["ssm:DescribeParameters"],
        effect: Effect.ALLOW,
        resources: [
          Arn.format(
            {
              service: "ssm",
              resource: "parameter",
              resourceName: "/eventual/services",
            },
            stack
          ),
        ],
      })
    );
  }

  public metricAdvanceExecutionDuration(options?: MetricOptions): Metric {
    return this.metric({
      statistic: Statistic.AVERAGE,
      metricName: OrchestratorMetrics.AdvanceExecutionDuration,
      unit: Unit.MILLISECONDS,
      ...options,
    });
  }

  public metricCommandsInvoked(options?: MetricOptions): Metric {
    return this.metric({
      statistic: Statistic.AVERAGE,
      metricName: OrchestratorMetrics.CallsInvoked,
      unit: Unit.COUNT,
      ...options,
    });
  }

  public metricInvokeCommandsDuration(options?: MetricOptions): Metric {
    return this.metric({
      statistic: Statistic.AVERAGE,
      metricName: OrchestratorMetrics.InvokeCallsDuration,
      unit: Unit.MILLISECONDS,
      ...options,
    });
  }

  public metricLoadHistoryDuration(options?: MetricOptions): Metric {
    return this.metric({
      statistic: Statistic.AVERAGE,
      metricName: OrchestratorMetrics.LoadHistoryDuration,
      unit: Unit.MILLISECONDS,
      ...options,
    });
  }

  public metricSaveHistoryDuration(options?: MetricOptions): Metric {
    return this.metric({
      statistic: Statistic.AVERAGE,
      metricName: OrchestratorMetrics.SaveHistoryDuration,
      unit: Unit.MILLISECONDS,
      ...options,
    });
  }

  public metricSavedHistoryBytes(options?: MetricOptions): Metric {
    return this.metric({
      metricName: OrchestratorMetrics.SavedHistoryBytes,
      unit: Unit.BYTES,
      statistic: Statistic.AVERAGE,
      ...options,
    });
  }

  public metricSavedHistoryEvents(options?: MetricOptions): Metric {
    return this.metric({
      metricName: OrchestratorMetrics.SavedHistoryEvents,
      unit: Unit.COUNT,
      statistic: Statistic.AVERAGE,
      ...options,
    });
  }

  public metricMaxTaskAge(options?: MetricOptions): Metric {
    return this.metric({
      statistic: Statistic.AVERAGE,
      metricName: OrchestratorMetrics.MaxTaskAge,
      unit: Unit.MILLISECONDS,
      ...options,
    });
  }

  private metric(
    options: MetricOptions & {
      metricName: string;
    }
  ) {
    return new Metric({
      ...options,
      namespace: MetricsCommon.EventualNamespace,
      dimensionsMap: {
        ...options?.dimensionsMap,
        [MetricsCommon.ServiceNameDimension]: this.serviceName,
      },
    });
  }
}

export function runtimeHandlersEntrypoint(name: string) {
  return path.join(runtimeEntrypoint(), `/handlers/${name}.js`);
}

export function runtimeEntrypoint() {
  return path.join(require.resolve("@eventual/aws-runtime"), `../../esm`);
}

export interface ServiceConstructProps {
  /**
   * The built service describing the event subscriptions within the Service.
   */
  readonly build: BuildOutput;
  /**
   * Optional environment variables to add to the {@link EventService.defaultHandler}.
   *
   * @default - no extra environment variables
   */
  readonly environment?: Record<string, string>;
  readonly service: LazyInterface<Service<any>>;
  readonly serviceName: string;
  readonly serviceScope: Construct;
  readonly systemScope: Construct;
  readonly eventualServiceScope: Construct;
}

export class EventualResource implements IGrantable {
  public grantPrincipal: IPrincipal;
  constructor(public handler: Function, local?: ServiceLocal) {
    this.grantPrincipal = local
      ? new DeepCompositePrincipal(
          handler.grantPrincipal,
          local.environmentRole
        )
      : handler.grantPrincipal;
  }
}
