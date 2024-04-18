import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class NetworkModule extends Construct {
  public readonly mainSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const defaultVpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', {
      isDefault: true
    });

    const defaultSubnet = ec2.Subnet.fromSubnetId(this, 'DefaultSubnet', defaultVpc.publicSubnets[0].subnetId);

    const mainSecurityGroup = new ec2.SecurityGroup(this, 'MainSecurityGroup', {
      vpc: defaultVpc,
      description: 'Main Security Group',
      allowAllOutbound: true,
      allowAllIpv6Outbound: true
    });
    mainSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SSH access from anywhere');
    mainSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP access from anywhere');
    mainSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS access from anywhere');
    mainSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5222), 'MTProto-specified port');

    // This also adds a route table entry that according to AWS documentation, we canot modify
    // https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html
    defaultVpc.addGatewayEndpoint('S3GatewayEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3
    });

    this.mainSecurityGroup = mainSecurityGroup;
  }
}
