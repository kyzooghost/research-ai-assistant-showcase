import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import EnvConstants from '../../../env/env.dev.json';

interface EmbeddingModuleProps extends cdk.StackProps {
  securityGroup: ec2.ISecurityGroup;
  secretsPolicy: iam.Policy;
}

export class EmbeddingClusterModule extends Construct {
  embeddingRepositoryUri: string;
  cluster: ecs.Cluster;
  executionRole: iam.Role;
  ecsTargetPolicy: iam.Policy;

  constructor(scope: Construct, id: string, props: EmbeddingModuleProps) {
    super(scope, id);

    const uploadChatRule = new events.Rule(this, 'uploadChatRule', {
      ruleName: 'uploadChatRule',
      eventPattern: {
        source: ['aws.s3'],
        resources: [`arn:aws:s3:::${EnvConstants.S3BucketName}`],
        detailType: ['Object Created'],
        detail: {
          object: {
            key: [{ wildcard: `${EnvConstants.S3ChatFolder}/*` }]
          }
        }
      }
    });

    const defaultVpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', {
      isDefault: true
    });

    const defaultSubnet = ec2.Subnet.fromSubnetId(this, 'DefaultSubnet', defaultVpc.publicSubnets[0].subnetId);

    const taskRole = new iam.Role(this, 'EmbeddingTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      roleName: 'EmbeddingTaskRole'
    });
    taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'));
    taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLogsFullAccess'));
    taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
    taskRole.attachInlinePolicy(props.secretsPolicy);

    const executionRole = new iam.Role(this, 'EmbeddingExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      roleName: 'EmbeddingExecutionRole'
    });
    executionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
    );
    const ecsTargetPolicy = new iam.Policy(this, 'ecs-target-policy', {
      statements: [
        new iam.PolicyStatement({
          actions: ['ecs:RunTask', 'iam:ListInstanceProfiles', 'iam:ListRoles', 'iam:PassRole'],
          resources: ['*']
        })
      ]
    });
    executionRole.attachInlinePolicy(ecsTargetPolicy);

    const embeddingCluster = new ecs.Cluster(this, 'EmbeddingCluster', {
      vpc: defaultVpc,
      clusterName: 'EmbeddingCluster',
      enableFargateCapacityProviders: true
    });

    const repository = new ecr.Repository(this, 'EmbeddingContainerRepo', {
      repositoryName: 'embedding-container',
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      lifecycleRules: [{ maxImageCount: 2 }]
    });

    this.embeddingRepositoryUri = repository.repositoryUri;

    const embeddingTaskDefinition = new ecs.FargateTaskDefinition(this, 'EmbeddingTask', {
      cpu: 512,
      memoryLimitMiB: 2048,
      executionRole: executionRole,
      taskRole: taskRole,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.X86_64
      }
    });

    // https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecs.ContainerDefinitionOptions.html
    const embeddingContainerLogGroup = new logs.LogGroup(this, 'EmbeddingContainerLogGroup', {
      logGroupName: 'embedding-container-logs'
    });

    const container = new ecs.ContainerDefinition(this, 'EmbeddingContainer', {
      taskDefinition: embeddingTaskDefinition,
      image: ecs.ContainerImage.fromRegistry(`${repository.repositoryUri}:latest`),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'embedding-container-logs',
        logGroup: embeddingContainerLogGroup,
        mode: ecs.AwsLogDriverMode.NON_BLOCKING,
        maxBufferSize: cdk.Size.mebibytes(25)
      })
    });

    const ecsTargetRole = new iam.Role(this, 'ECSTargetRole', {
      assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
      roleName: 'ECSTargetRole'
    });

    ecsTargetRole.attachInlinePolicy(ecsTargetPolicy);

    const dlq = new sqs.Queue(this, 'EmbeddingTaskDLQ', {
      queueName: 'EmbeddingTaskDLQ'
    });

    const dlqResourcePolicy = new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('events.amazonaws.com')],
      actions: ['sqs:SendMessage'],
      effect: iam.Effect.ALLOW,
      resources: [dlq.queueArn]
    });

    dlq.addToResourcePolicy(dlqResourcePolicy);

    uploadChatRule.addTarget(
      new targets.EcsTask({
        cluster: embeddingCluster,
        taskDefinition: embeddingTaskDefinition,
        taskCount: 1,
        containerOverrides: [
          {
            containerName: container.containerName,
            command: ['/usr/bin/python3', '/home/get-embedding.py', events.EventField.fromPath('$.detail.object.key')]
          }
        ],
        enableExecuteCommand: true,
        // Does not work as expected - very hacky fix below
        // assignPublicIp: true,
        role: ecsTargetRole,
        securityGroups: [props?.securityGroup],
        subnetSelection: {
          subnets: [defaultSubnet]
        },
        // Error catching
        retryAttempts: 3,
        deadLetterQueue: dlq
      })
    );

    // https://github.com/aws/aws-cdk/issues/9233#issuecomment-1145762756
    // Fix for bug where CDK does not allow us to have 'assignPublicIp = true' despite using a public subnet
    (uploadChatRule.node.defaultChild as cdk.CfnResource).addPropertyOverride(
      'Targets.0.EcsParameters.NetworkConfiguration.AwsVpcConfiguration.AssignPublicIp',
      'ENABLED'
    );

    const eventLog = new logs.LogGroup(this, 'uploadChatRuleEventLog', {
      logGroupName: 'uploadChatRuleEventLog'
    });

    uploadChatRule.addTarget(new targets.CloudWatchLogGroup(eventLog, {}));

    this.cluster = embeddingCluster;
    this.executionRole = executionRole;
    this.ecsTargetPolicy = ecsTargetPolicy;
  }
}
