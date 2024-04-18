import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import EnvConstants from '../../../env/env.dev.json';

interface QueryAPIModuleProps extends cdk.StackProps {
  securityGroup: ec2.ISecurityGroup;
  chromaDBAccessPoint: efs.AccessPoint;
  secretsPolicy: iam.Policy;
}

export class QueryAPIModule extends Construct {
  userQueryRepository: ecr.Repository;
  userQueryLambdaRole: iam.Role;

  constructor(scope: Construct, id: string, props: QueryAPIModuleProps) {
    super(scope, id);

    /*** context-window-lambda ***/

    const contextWindowRepository = new ecr.Repository(this, 'ContextWindowLambdaRepository', {
      repositoryName: EnvConstants.ContextWindowLambdaImageName,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      lifecycleRules: [{ maxImageCount: 2 }]
    });

    const contextWindowLambdaRole = new iam.Role(this, 'ContextWindowLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });
    contextWindowLambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );
    contextWindowLambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')
    );
    contextWindowLambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonElasticFileSystemClientFullAccess')
    );

    const defaultVpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', {
      isDefault: true
    });

    const defaultSubnet = ec2.Subnet.fromSubnetId(this, 'DefaultSubnet', defaultVpc.publicSubnets[0].subnetId);

    const contextWindowLambda = new lambda.Function(this, 'ContextWindowLambda', {
      code: lambda.Code.fromEcrImage(contextWindowRepository),
      handler: lambda.Handler.FROM_IMAGE,
      runtime: lambda.Runtime.FROM_IMAGE,
      role: contextWindowLambdaRole,
      filesystem: lambda.FileSystem.fromEfsAccessPoint(
        props?.chromaDBAccessPoint,
        EnvConstants.ChromaDBLambdaMountDirectory
      ),
      environment: {
        ChromaDBLambdaMountDirectory: EnvConstants.ChromaDBLambdaMountDirectory,
        ChromaDBCollectionName: EnvConstants.ChromaDBCollectionName,
        ContextWindowTokenLength: EnvConstants.ContextWindowTokenLength,
        TokensPerMessage: EnvConstants.TokensPerMessage
      },
      functionName: EnvConstants.ContextWindowLambdaImageName,
      memorySize: 8192,
      securityGroups: [props?.securityGroup],
      vpc: defaultVpc,
      vpcSubnets: { subnets: [defaultSubnet] },
      allowPublicSubnet: true,
      timeout: cdk.Duration.seconds(300)
    });

    /*** reset-db-lambda ***/

    const resetDbRepository = new ecr.Repository(this, 'ResetDBLambdaRepository', {
      repositoryName: EnvConstants.ResetDBLambdaImageName,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      lifecycleRules: [{ maxImageCount: 2 }]
    });

    // Nuclear Lambda that wipes out DB

    const resetDbLambda = new lambda.Function(this, 'ResetDBLambda', {
      code: lambda.Code.fromEcrImage(resetDbRepository),
      handler: lambda.Handler.FROM_IMAGE,
      runtime: lambda.Runtime.FROM_IMAGE,
      role: contextWindowLambdaRole,
      filesystem: lambda.FileSystem.fromEfsAccessPoint(
        props?.chromaDBAccessPoint,
        EnvConstants.ChromaDBLambdaMountDirectory
      ),
      environment: {
        ChromaDBLambdaMountDirectory: EnvConstants.ChromaDBLambdaMountDirectory,
        ChromaDBCollectionName: EnvConstants.ChromaDBCollectionName,
        ALLOW_RESET: 'TRUE'
      },
      functionName: EnvConstants.ResetDBLambdaImageName,
      memorySize: 512,
      securityGroups: [props?.securityGroup],
      vpc: defaultVpc,
      vpcSubnets: { subnets: [defaultSubnet] },
      allowPublicSubnet: true,
      timeout: cdk.Duration.seconds(300)
    });

    /*** user-query-lambda ***/

    const userQueryRepository = new ecr.Repository(this, 'UserQueryLambdaRepository', {
      repositoryName: EnvConstants.UserQueryLambdaImageName,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      lifecycleRules: [{ maxImageCount: 2 }]
    });

    const userQueryLambdaRole = new iam.Role(this, 'UserQueryLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      roleName: 'UserQueryLambdaRole'
    });

    userQueryLambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );
    userQueryLambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaRole'));
    userQueryLambdaRole.attachInlinePolicy(props?.secretsPolicy);
    userQueryLambdaRole.attachInlinePolicy(
      new iam.Policy(this, 'GetParameterStorePolicy', {
        statements: [
          new iam.PolicyStatement({
            actions: ['ssm:GetParameter'],
            effect: iam.Effect.ALLOW,
            resources: ['*']
          })
        ]
      })
    );

    const userQueryLambda = new lambda.Function(this, 'UserQueryLambda', {
      code: lambda.Code.fromEcrImage(userQueryRepository),
      handler: lambda.Handler.FROM_IMAGE,
      runtime: lambda.Runtime.FROM_IMAGE,
      role: userQueryLambdaRole,
      environment: {
        CONTEXT_WINDOW_LAMBDA_NAME: EnvConstants.ContextWindowLambdaImageName,
        GPT_MODEL: EnvConstants.GPTModel,
        USER: '',
      },
      functionName: EnvConstants.UserQueryLambdaImageName,
      memorySize: 256,
      timeout: cdk.Duration.seconds(300)
    });

    const userQueryFunctionUrl = userQueryLambda.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ['*'],
        allowedHeaders: ['*']
      }
    });

    /*** Set class exports ***/
    this.userQueryRepository = userQueryRepository;
    this.userQueryLambdaRole = userQueryLambdaRole;
  }
}
