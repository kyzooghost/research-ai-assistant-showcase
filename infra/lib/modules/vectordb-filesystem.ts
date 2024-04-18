import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface VectorDBFileSystemModuleProps extends cdk.StackProps {
  securityGroup: ec2.ISecurityGroup;
}

export class VectorDBFileSystemModule extends Construct {
  chromaDBAccessPoint: efs.AccessPoint;

  constructor(scope: Construct, id: string, props: VectorDBFileSystemModuleProps) {
    super(scope, id);

    const defaultVpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', {
      isDefault: true
    });

    const defaultSubnet = ec2.Subnet.fromSubnetId(this, 'DefaultSubnet', defaultVpc.publicSubnets[0].subnetId);

    const fileSystem = new efs.FileSystem(this, 'EmbeddingsFileSystem', {
      vpc: defaultVpc,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      allowAnonymousAccess: false,
      fileSystemName: 'EmbeddingsFileSystem',
      vpcSubnets: { subnets: [defaultSubnet] },
      securityGroup: props?.securityGroup,
      // Daily backups with 35-day retention periods - https://docs.aws.amazon.com/efs/latest/ug/awsbackup.html#automatic-backups
      // Use AWS Backup Console for recovery - https://docs.aws.amazon.com/efs/latest/ug/awsbackup.html#restoring-backup-efs
      enableAutomaticBackups: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      outOfInfrequentAccessPolicy: efs.OutOfInfrequentAccessPolicy.AFTER_1_ACCESS
    });

    const fileSystemPolicyStatement = new iam.PolicyStatement({
      principals: [new iam.AnyPrincipal()],
      actions: ['elasticfilesystem:ClientRootAccess', 'elasticfilesystem:ClientWrite', 'elasticfilesystem:ClientMount'],
      resources: ['*']
    });

    fileSystem.addToResourcePolicy(fileSystemPolicyStatement);

    // In future, we shouldn't use the 'root' of the access point as the location of the chromadb persistent directory
    // i.) Seems like there is some bug on initialization that requires removing and recreating the chromadb.sqlite3 file
    // ii.) We need to be able to do manual backups of the chromadb store
    const chromaDBAccessPoint = new efs.AccessPoint(this, 'ChromaDBAccessPoint', {
      fileSystem: fileSystem,
      path: '/vectordb',
      createAcl: {
        ownerUid: '0',
        ownerGid: '0',
        permissions: '755'
      },
      posixUser: {
        uid: '0',
        gid: '0'
      }
    });

    this.chromaDBAccessPoint = chromaDBAccessPoint;
  }
}
