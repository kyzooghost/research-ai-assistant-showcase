import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import EnvConstants from '../../env/env.dev.json';

export class BucketModule extends Construct {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'MainBucket', {
      bucketName: EnvConstants.S3BucketName,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      eventBridgeEnabled: true
    });
  }
}
