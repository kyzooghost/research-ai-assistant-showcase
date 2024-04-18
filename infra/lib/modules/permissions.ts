import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import EnvConstants from '../../env/env.dev.json';

export class PermissionsModule extends Construct {
  getParameterStorePolicy: iam.Policy;
  secretsPolicy: iam.Policy;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const getParameterStorePolicy = new iam.Policy(this, 'GetParameterStorePolicy', {
      statements: [
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          effect: iam.Effect.ALLOW,
          resources: ['*']
        })
      ]
    });

    const secretsPolicy = new iam.Policy(this, 'SecretsAccessPolicy', {
      statements: [
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          effect: iam.Effect.ALLOW,
          resources: [EnvConstants.SecretARN]
        }),
        new iam.PolicyStatement({
          actions: ['kms:Decrypt'],
          effect: iam.Effect.ALLOW,
          resources: [EnvConstants.SecretKeyARN]
        })
      ]
    });

    this.getParameterStorePolicy = getParameterStorePolicy;
    this.secretsPolicy = secretsPolicy;
  }
}
