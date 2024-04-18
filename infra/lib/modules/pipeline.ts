import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import EnvConstants from '../../env/env.dev.json';

interface PipelineModuleProps extends cdk.StackProps {
  bucket: IBucket;
  embeddingRepositoryUri: string; // ACCOUNT.dkr.ecr.REGION.amazonaws.com/REPOSITORY
}

export class PipelineModule extends Construct {
  pipeline: codepipeline.IPipeline;

  constructor(scope: Construct, id: string, props?: PipelineModuleProps) {
    super(scope, id);

    /*** IAM Roles ***/
    const pipelineRole = new iam.Role(this, 'PipelineRole', {
      assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
      roleName: 'PipelineRole'
    });
    pipelineRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'));
    pipelineRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLogsFullAccess'));
    pipelineRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLogsFullAccess'));

    pipelineRole.attachInlinePolicy(
      new iam.Policy(this, 'pipeline-policy', {
        statements: [
          new iam.PolicyStatement({
            actions: [
              'codebuild:BatchGetBuilds',
              'codebuild:StartBuild',
              'codestar-connections:UseConnection',
              'codedeploy:Batch*',
              'codedeploy:CreateDeployment',
              'codedeploy:Get*',
              'codedeploy:List*',
              'codedeploy:RegisterApplicationRevision'
            ],
            resources: ['*']
          })
        ]
      })
    );

    const codebuildRole = new iam.Role(this, 'CodeBuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      roleName: 'CodeBuildRole'
    });
    codebuildRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'));
    codebuildRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLogsFullAccess'));
    codebuildRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2FullAccess'));
    codebuildRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryPowerUser'));

    codebuildRole.attachInlinePolicy(
      new iam.Policy(this, 'codebuild-policy', {
        statements: [
          new iam.PolicyStatement({
            actions: ['lambda:UpdateFunctionCode'],
            resources: ['*']
          })
        ]
      })
    );

    const pipeline = new codepipeline.Pipeline(this, 'AIResearchAssistantPipeline', {
      artifactBucket: props?.bucket,
      pipelineName: 'social-media-researcher-pipeline',
      role: pipelineRole
    });

    /*** Source Stage ***/
    const sourceOutput = new codepipeline.Artifact();
    const sourceStage = pipeline.addStage({
      stageName: 'Source',
      actions: [
        new codepipeline_actions.CodeStarConnectionsSourceAction({
          actionName: 'GithubSource',
          owner: EnvConstants.RepoOwner,
          repo: EnvConstants.RepoName,
          output: sourceOutput,
          branch: 'main',
          connectionArn: EnvConstants.CodestarConnectionArn,
          role: pipelineRole,
          triggerOnPush: true,
          runOrder: 1
        })
      ]
    });

    /*** CodeBuild ***/

    const uploadScriptsContainer = new codebuild.PipelineProject(this, `UploadScriptsContainer`, {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: [
              // CICD pipeline for embedding-container - https://aws.amazon.com/blogs/devops/build-a-continuous-delivery-pipeline-for-your-container-images-with-amazon-ecr-as-source/
              'echo "Rebuilding embedding-container image.."',
              `cd microservices/embedding-container`,
              `make build`,
              'aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${ECR_REGISTRY}',
              'docker tag ${EMBEDDING_IMAGE_NAME} ${ECR_REGISTRY}/${EMBEDDING_IMAGE_NAME}',
              'docker push ${ECR_REGISTRY}/${EMBEDDING_IMAGE_NAME}',
              'cd ../..',

              // CICD pipeline for vectordb-appender
              'echo "Rebuilding vectordb-appender image.."',
              `cd microservices/vectordb-appender`,
              `make build`,
              'docker tag ${VECTORDB_APPENDER_IMAGE_NAME} ${ECR_REGISTRY}/${VECTORDB_APPENDER_IMAGE_NAME}',
              'docker push ${ECR_REGISTRY}/${VECTORDB_APPENDER_IMAGE_NAME}',
              // Must invalidate Lambda cache
              'aws lambda update-function-code --region us-west-2 --function-name ${VECTORDB_APPENDER_IMAGE_NAME} --image-uri ${ECR_REGISTRY}/${VECTORDB_APPENDER_IMAGE_NAME}:latest',
              'cd ../..',

              // CICD pipeline for context-window-lambda
              'echo "Rebuilding context-window-lambda image.."',
              `cd microservices/query-api/context-window-lambda`,
              `make build`,
              'docker tag ${ContextWindowLambdaImageName} ${ECR_REGISTRY}/${ContextWindowLambdaImageName}',
              'docker push ${ECR_REGISTRY}/${ContextWindowLambdaImageName}',
              // Must invalidate Lambda cache
              'aws lambda update-function-code --region us-west-2 --function-name ${ContextWindowLambdaImageName} --image-uri ${ECR_REGISTRY}/${ContextWindowLambdaImageName}:latest',
              'cd ../../..',

              // CICD pipeline for user-query-lambda
              'echo "Rebuilding user-query-lambda image.."',
              `cd microservices/query-api/user-query-lambda`,
              `make build`,
              'docker tag ${UserQueryLambdaImageName} ${ECR_REGISTRY}/${UserQueryLambdaImageName}',
              'docker push ${ECR_REGISTRY}/${UserQueryLambdaImageName}',
              // Must invalidate Lambda cache
              'aws lambda update-function-code --region us-west-2 --function-name ${UserQueryLambdaImageName} --image-uri ${ECR_REGISTRY}/${UserQueryLambdaImageName}:latest',
              'cd ../../..',
            ]
          }
        }
      }),
      role: codebuildRole,
      environmentVariables: {
        S3_BUCKET: { value: EnvConstants.S3BucketName },
        ECR_REGISTRY: { value: props?.embeddingRepositoryUri.split('/')[0] },
        EMBEDDING_IMAGE_NAME: { value: EnvConstants.EmbeddingContainerImageName },
        VECTORDB_APPENDER_IMAGE_NAME: { value: EnvConstants.VectorDBAppenderImageName },
        ContextWindowLambdaImageName: { value: EnvConstants.ContextWindowLambdaImageName },
        UserQueryLambdaImageName: { value: EnvConstants.UserQueryLambdaImageName },
      },
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0
      }
    });

    /*** Upload Scripts Stage ***/
    const uploadScriptsStage = pipeline.addStage({
      stageName: 'UploadScripts',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'UploadScripts',
          project: uploadScriptsContainer,
          input: sourceOutput,
          role: pipelineRole
        })
      ]
    });
  }
}
