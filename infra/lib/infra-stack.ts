import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  BucketModule,
  EmbeddingClusterModule,
  NetworkModule,
  ParameterStoreModule,
  PermissionsModule,
  PipelineModule,
  QueryAPIModule,
  VectorDBAppenderModule,
  VectorDBFileSystemModule,
} from './modules';

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const permissionsModule = new PermissionsModule(this, 'PermissionsModule');
    const networkModule = new NetworkModule(this, 'NetworkModule');
    const bucketModule = new BucketModule(this, 'BucketModule');

    const parameterStoreModule = new ParameterStoreModule(this, 'ParameterStoreModule');
    const embeddingClusterModule = new EmbeddingClusterModule(this, 'EmbeddingClusterModule', {
      securityGroup: networkModule.mainSecurityGroup,
      secretsPolicy: permissionsModule.secretsPolicy
    });

    const vectorDBFileSystemModule = new VectorDBFileSystemModule(this, 'VectorDBFileSystemModule', {
      securityGroup: networkModule.mainSecurityGroup
    });

    const vectorDbAppenderModule = new VectorDBAppenderModule(this, 'VectorDBAppenderModule', {
      securityGroup: networkModule.mainSecurityGroup,
      chromaDBAccessPoint: vectorDBFileSystemModule.chromaDBAccessPoint
    });

    const queryAPIModule = new QueryAPIModule(this, 'QueryAPIModule', {
      securityGroup: networkModule.mainSecurityGroup,
      chromaDBAccessPoint: vectorDBFileSystemModule.chromaDBAccessPoint,
      secretsPolicy: permissionsModule.secretsPolicy
    });

    const pipelineModule = new PipelineModule(this, 'PipelineModule', {
      bucket: bucketModule.bucket,
      embeddingRepositoryUri: embeddingClusterModule.embeddingRepositoryUri
    });
  }
}
