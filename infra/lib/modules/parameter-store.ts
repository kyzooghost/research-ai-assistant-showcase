import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import EnvConstants from '../../env/env.dev.json';

export class ParameterStoreModule extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new ssm.StringParameter(this, 'SecretARNParameter', {
      parameterName: 'SecretARN',
      stringValue: EnvConstants.SecretARN
    });

    new ssm.StringParameter(this, 'S3BucketNameParameter', {
      parameterName: 'S3BucketName',
      stringValue: EnvConstants.S3BucketName
    });

    new ssm.StringParameter(this, 'S3ChatFolderParameter', {
      parameterName: 'S3ChatFolder',
      stringValue: EnvConstants.S3ChatFolder
    });

    new ssm.StringParameter(this, 'EmbeddingsFolderParameter', {
      parameterName: 'EmbeddingsFolder',
      stringValue: EnvConstants.EmbeddingsFolder
    });
  }
}
