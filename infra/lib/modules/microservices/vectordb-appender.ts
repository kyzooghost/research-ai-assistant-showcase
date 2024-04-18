import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import EnvConstants from '../../../env/env.dev.json';

interface VectorDBAppenderModuleProps extends cdk.StackProps {
  securityGroup: ec2.ISecurityGroup;
  chromaDBAccessPoint: efs.AccessPoint;
}

export class VectorDBAppenderModule extends Construct {
  constructor(scope: Construct, id: string, props: VectorDBAppenderModuleProps) {
    super(scope, id);
    // https://aws.amazon.com/blogs/compute/using-amazon-efs-for-aws-lambda-in-your-serverless-applications/

    const defaultVpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', {
      isDefault: true
    });

    const defaultSubnet = ec2.Subnet.fromSubnetId(this, 'DefaultSubnet', defaultVpc.publicSubnets[0].subnetId);

    // Timeout for vectordb-appender lambda
    const vectorDbAppenderTimeout = 180;

    /*** S3 -> EventBridge ***/

    const uploadChatEmbeddingsRule = new events.Rule(this, 'UploadChatEmbeddingsRule', {
      ruleName: 'uploadChatEmbeddingsRule',
      eventPattern: {
        source: ['aws.s3'],
        resources: [`arn:aws:s3:::${EnvConstants.S3BucketName}`],
        detailType: ['Object Created'],
        detail: {
          object: {
            key: [{ wildcard: `${EnvConstants.EmbeddingsFolder}/*` }]
          }
        }
      }
    });

    const eventLog = new logs.LogGroup(this, 'uploadChatEmbeddingsRuleEventLog', {
      logGroupName: 'uploadChatEmbeddingsRuleEventLog'
    });

    uploadChatEmbeddingsRule.addTarget(new targets.CloudWatchLogGroup(eventLog, {}));

    /*** EventBridge -> SQS ***/

    const jobQueueDlq = new sqs.Queue(this, 'VectorDBAppenderJobQueueDLQ', {
      queueName: 'VectorDBAppenderJobQueueDLQ.fifo',
      fifo: true
    });

    const dlqResourcePolicy = new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('sqs.amazonaws.com')],
      actions: ['sqs:SendMessage'],
      effect: iam.Effect.ALLOW,
      resources: [jobQueueDlq.queueArn]
    });

    jobQueueDlq.addToResourcePolicy(dlqResourcePolicy);

    const jobQueue = new sqs.Queue(this, 'VectorDBAppenderJobQueue', {
      queueName: 'VectorDBAppenderJobQueue.fifo',
      // Only FIFO queue supports no-concurrency of message batch processing. Standard queue has minimum of 2 concurrent function invocations
      fifo: true,
      deadLetterQueue: {
        queue: jobQueueDlq,
        maxReceiveCount: 1
      },
      // AWS recommend SQS visibility timeout to be at least 6x Lambda timeout, to allow for Lambda retries
      visibilityTimeout: cdk.Duration.seconds(vectorDbAppenderTimeout * 3),
      contentBasedDeduplication: true
    });

    const eventBridgeToSqsTargetDLQ = new sqs.Queue(this, 'VectorDbAppenderEventBridgeToSqsTargetDLQ', {
      queueName: 'VectorDbAppenderEventBridgeToSqsTargetDLQ'
    });

    // TODO - Do we need a DLQ here? Can we assume that EventBridge -> SQS target won't require debugging?
    const jobQueueTarget = new targets.SqsQueue(jobQueue, {
      deadLetterQueue: eventBridgeToSqsTargetDLQ,
      messageGroupId: 'vectordb-appender-lambda-jobs',
      retryAttempts: 3
    });

    uploadChatEmbeddingsRule.addTarget(jobQueueTarget);

    /*** vectordb-appender Lambda ***/

    const repository = new ecr.Repository(this, 'VectorDBAdderRepo', {
      repositoryName: EnvConstants.VectorDBAppenderImageName,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      lifecycleRules: [{ maxImageCount: 2 }]
    });

    const lambdaRole = new iam.Role(this, 'VectorDBAppenderLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });
    lambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'));
    lambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'));
    lambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')
    );
    lambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonElasticFileSystemClientFullAccess'));

    const vectorDbAppenderFunction = new lambda.Function(this, 'VectorDbAppenderFunction', {
      code: lambda.Code.fromEcrImage(repository),
      handler: lambda.Handler.FROM_IMAGE,
      runtime: lambda.Runtime.FROM_IMAGE,
      role: lambdaRole,
      filesystem: lambda.FileSystem.fromEfsAccessPoint(
        props?.chromaDBAccessPoint,
        EnvConstants.ChromaDBLambdaMountDirectory
      ),
      environment: {
        ChromaDBLambdaMountDirectory: EnvConstants.ChromaDBLambdaMountDirectory,
        ChromaDBCollectionName: EnvConstants.ChromaDBCollectionName,
        S3BucketName: EnvConstants.S3BucketName
      },
      functionName: EnvConstants.VectorDBAppenderImageName,
      memorySize: 8196,
      securityGroups: [props?.securityGroup],
      vpc: defaultVpc,
      vpcSubnets: { subnets: [defaultSubnet] },
      allowPublicSubnet: true,
      timeout: cdk.Duration.seconds(vectorDbAppenderTimeout),
      // Must ensure only one instance of this Lambda is running at one time, because ChromaDB upsert is not thread-safe.
      reservedConcurrentExecutions: 1,
      retryAttempts: 1
    });

    /*** SQS -> Lambda ***/

    vectorDbAppenderFunction.addEventSource(
      new SqsEventSource(jobQueue, {
        batchSize: 1
      })
    );
  }
}
