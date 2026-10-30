import { createRequire } from 'node:module';
import { isIP } from 'node:net';
const require = createRequire(import.meta.url);
export const providers = { tencent: '腾讯云', alibaba: '阿里云', huawei: '华为云', aws: 'AWS' };
const protocol = (p) =>
  ({ 6: 'tcp', 17: 'udp', '-1': 'all' })[p] || String(p || 'all').toLowerCase();
const common = (id, direction, p, ports, cidr, description, raw, action = 'allow') => ({
  id: String(id),
  direction,
  protocol: protocol(p),
  ports: String(ports || 'all'),
  cidr: cidr || '安全组 / 地址模板',
  description: description || '',
  action,
  raw,
});
export function adapter(provider, secrets, region, projectId) {
  if (provider === 'tencent') {
    const SDK = require('tencentcloud-sdk-nodejs-vpc');
    const client = new SDK.vpc.v20170312.Client({
      credential: {
        secretId: secrets.accessKeyId,
        secretKey: secrets.secretAccessKey,
        token: secrets.sessionToken || undefined,
      },
      region,
      profile: {
        httpProfile: { endpoint: 'vpc.tencentcloudapi.com', reqTimeout: 15 },
        signMethod: 'TC3-HMAC-SHA256',
      },
    });
    return {
      async groups() {
        const groups = [];
        for (let offset = 0; offset < 2000; offset += 100) {
          const r = await client.DescribeSecurityGroups({ Offset: String(offset), Limit: '100' });
          for (const g of r.SecurityGroupSet || [])
            groups.push({ id: g.SecurityGroupId, name: g.SecurityGroupName });
          if (groups.length >= Number(r.TotalCount) || !r.SecurityGroupSet?.length) break;
        }
        return groups;
      },
      async list(group) {
        const r = await client.DescribeSecurityGroupPolicies({ SecurityGroupId: group }),
          set = r.SecurityGroupPolicySet || {};
        return {
          version: String(set.Version ?? ''),
          rules: ['Ingress', 'Egress'].flatMap((key) =>
            (set[key] || []).map((rule) =>
              common(
                rule.PolicyIndex,
                key.toLowerCase(),
                rule.Protocol,
                rule.Port,
                rule.CidrBlock || rule.Ipv6CidrBlock || rule.SecurityGroupId,
                rule.PolicyDescription,
                rule,
                rule.Action === 'DROP' ? 'deny' : 'allow',
              ),
            ),
          ),
        };
      },
      async add(group, rule) {
        const key = rule.direction === 'ingress' ? 'Ingress' : 'Egress';
        const p = {
          Protocol: rule.protocol.toUpperCase(),
          Port: rule.from === rule.to ? String(rule.from) : `${rule.from}-${rule.to}`,
          Action: 'ACCEPT',
          PolicyDescription: rule.description,
          [isIP(rule.cidr.split('/')[0]) === 6 ? 'Ipv6CidrBlock' : 'CidrBlock']: rule.cidr,
        };
        return client.CreateSecurityGroupPolicies({
          SecurityGroupId: group,
          SecurityGroupPolicySet: { [key]: [p] },
        });
      },
      async remove(group, rule, version) {
        return client.DeleteSecurityGroupPolicies({
          SecurityGroupId: group,
          SecurityGroupPolicySet: {
            Version: version,
            [rule.direction === 'ingress' ? 'Ingress' : 'Egress']: [
              { PolicyIndex: Number(rule.id) },
            ],
          },
        });
      },
    };
  }
  if (provider === 'alibaba') {
    const SDK = require('@alicloud/ecs20140526'),
      OpenApi = require('@alicloud/openapi-client');
    const client = new SDK.default(
      new OpenApi.Config({
        accessKeyId: secrets.accessKeyId,
        accessKeySecret: secrets.secretAccessKey,
        securityToken: secrets.sessionToken || undefined,
        regionId: region,
        endpoint: `ecs.${region}.aliyuncs.com`,
        connectTimeout: 5000,
        readTimeout: 15000,
      }),
    );
    return {
      async groups() {
        const groups = [];
        for (let pageNumber = 1; pageNumber <= 20; pageNumber++) {
          const r = await client.describeSecurityGroups(
            new SDK.DescribeSecurityGroupsRequest({ regionId: region, pageNumber, pageSize: 100 }),
          );
          for (const g of r.body.securityGroups?.securityGroup || [])
            groups.push({ id: g.securityGroupId, name: g.securityGroupName });
          if (groups.length >= r.body.totalCount) break;
        }
        return groups;
      },
      async list(group) {
        let nextToken;
        const rules = [];
        do {
          const r = await client.describeSecurityGroupAttribute(
            new SDK.DescribeSecurityGroupAttributeRequest({
              regionId: region,
              securityGroupId: group,
              direction: 'all',
              maxResults: 1000,
              nextToken,
            }),
          );
          for (const p of r.body.permissions?.permission || [])
            rules.push(
              common(
                p.securityGroupRuleId || '',
                p.direction,
                p.ipProtocol,
                p.portRange,
                p.sourceCidrIp ||
                  p.ipv6SourceCidrIp ||
                  p.destCidrIp ||
                  p.ipv6DestCidrIp ||
                  p.sourceGroupId ||
                  p.destGroupId,
                p.description,
                p,
                p.policy === 'drop' ? 'deny' : 'allow',
              ),
            );
          nextToken = r.body.nextToken;
        } while (nextToken && rules.length < 5000);
        return { version: '', rules };
      },
      async add(group, rule) {
        const ingress = rule.direction === 'ingress',
          family = isIP(rule.cidr.split('/')[0]);
        const cidrKey = ingress
          ? family === 6
            ? 'ipv6SourceCidrIp'
            : 'sourceCidrIp'
          : family === 6
            ? 'ipv6DestCidrIp'
            : 'destCidrIp';
        const permission = {
          ipProtocol: rule.protocol,
          portRange: `${rule.from}/${rule.to}`,
          policy: 'accept',
          priority: '1',
          description: rule.description || 'Server Harbor',
          [cidrKey]: rule.cidr,
        };
        const Permission = ingress
          ? SDK.AuthorizeSecurityGroupRequestPermissions
          : SDK.AuthorizeSecurityGroupEgressRequestPermissions;
        const params = {
          regionId: region,
          securityGroupId: group,
          permissions: [new Permission(permission)],
        };
        return ingress
          ? client.authorizeSecurityGroup(new SDK.AuthorizeSecurityGroupRequest(params))
          : client.authorizeSecurityGroupEgress(
              new SDK.AuthorizeSecurityGroupEgressRequest(params),
            );
      },
      async remove(group, rule) {
        if (!rule.id)
          throw Object.assign(new Error('Legacy rule has no stable id'), {
            code: 'RULE_ID_REQUIRED',
          });
        const params = { regionId: region, securityGroupId: group, securityGroupRuleId: [rule.id] };
        return rule.direction === 'ingress'
          ? client.revokeSecurityGroup(new SDK.RevokeSecurityGroupRequest(params))
          : client.revokeSecurityGroupEgress(new SDK.RevokeSecurityGroupEgressRequest(params));
      },
    };
  }
  if (provider === 'aws') {
    const SDK = require('@aws-sdk/client-ec2');
    const client = new SDK.EC2Client({
      region,
      maxAttempts: 1,
      credentials: {
        accessKeyId: secrets.accessKeyId,
        secretAccessKey: secrets.secretAccessKey,
        sessionToken: secrets.sessionToken || undefined,
      },
    });
    const send = (name, data) =>
      client.send(new SDK[name + 'Command'](data), { abortSignal: AbortSignal.timeout(15000) });
    return {
      async groups() {
        let NextToken;
        const groups = [];
        do {
          const r = await send('DescribeSecurityGroups', { MaxResults: 100, NextToken });
          for (const g of r.SecurityGroups || []) groups.push({ id: g.GroupId, name: g.GroupName });
          NextToken = r.NextToken;
        } while (NextToken && groups.length < 2000);
        return groups;
      },
      async list(group) {
        let NextToken;
        const rules = [];
        do {
          const r = await send('DescribeSecurityGroupRules', {
            Filters: [{ Name: 'group-id', Values: [group] }],
            MaxResults: 100,
            NextToken,
          });
          for (const p of r.SecurityGroupRules || [])
            rules.push(
              common(
                p.SecurityGroupRuleId,
                p.IsEgress ? 'egress' : 'ingress',
                p.IpProtocol,
                p.FromPort === undefined ? 'all' : `${p.FromPort}-${p.ToPort}`,
                p.CidrIpv4 || p.CidrIpv6 || p.ReferencedGroupInfo?.GroupId || p.PrefixListId,
                p.Description,
                p,
              ),
            );
          NextToken = r.NextToken;
        } while (NextToken && rules.length < 5000);
        return { version: '', rules };
      },
      async add(group, rule) {
        const ipv6 = isIP(rule.cidr.split('/')[0]) === 6;
        const permission = {
          IpProtocol: rule.protocol,
          FromPort: rule.from,
          ToPort: rule.to,
          [ipv6 ? 'Ipv6Ranges' : 'IpRanges']: [
            {
              [ipv6 ? 'CidrIpv6' : 'CidrIp']: rule.cidr,
              Description: rule.description || 'Server Harbor',
            },
          ],
        };
        return send(
          rule.direction === 'ingress'
            ? 'AuthorizeSecurityGroupIngress'
            : 'AuthorizeSecurityGroupEgress',
          { GroupId: group, IpPermissions: [permission] },
        );
      },
      async remove(group, rule) {
        return send(
          rule.direction === 'ingress' ? 'RevokeSecurityGroupIngress' : 'RevokeSecurityGroupEgress',
          { GroupId: group, SecurityGroupRuleIds: [rule.id] },
        );
      },
    };
  }
  if (provider === 'huawei') {
    const SDK = require('@huaweicloud/huaweicloud-sdk-vpc/v2/public-api');
    const { BasicCredentials } = require('@huaweicloud/huaweicloud-sdk-core/auth/BasicCredentials');
    if (!projectId)
      throw Object.assign(new Error('Project id required'), { code: 'PROJECT_ID_REQUIRED' });
    const credentials = new BasicCredentials()
      .withAk(secrets.accessKeyId)
      .withSk(secrets.secretAccessKey)
      .withProjectId(projectId);
    if (secrets.sessionToken) credentials.withSecurityToken(secrets.sessionToken);
    const client = SDK.VpcClient.newBuilder()
      .withCredential(credentials)
      .withEndpoint(`https://vpc.${region}.myhuaweicloud.com`)
      .withOptions({ customUserAgent: 'server-harbor/2.0', axiosRequestConfig: { timeout: 15000 } })
      .build();
    return {
      async groups() {
        let marker;
        const groups = [];
        do {
          const request = new SDK.ListSecurityGroupsRequest().withLimit(1000);
          if (marker) request.withMarker(marker);
          const r = await client.listSecurityGroups(request);
          const list = r.securityGroups || r.security_groups || [];
          for (const g of list) groups.push({ id: g.id, name: g.name });
          marker = list.length === 1000 ? list.at(-1).id : null;
        } while (marker && groups.length < 2000);
        return groups;
      },
      async list(group) {
        let marker;
        const rules = [];
        do {
          const request = new SDK.ListSecurityGroupRulesRequest()
            .withSecurityGroupId(group)
            .withLimit(1000);
          if (marker) request.withMarker(marker);
          const r = await client.listSecurityGroupRules(request);
          const list = r.securityGroupRules || r.security_group_rules || [];
          for (const p of list)
            rules.push(
              common(
                p.id,
                p.direction,
                p.protocol,
                (p.portRangeMin ?? p.port_range_min) == null
                  ? 'all'
                  : `${p.portRangeMin ?? p.port_range_min}-${p.portRangeMax ?? p.port_range_max}`,
                p.remoteIpPrefix || p.remote_ip_prefix || p.remoteGroupId || p.remote_group_id,
                p.description,
                p,
              ),
            );
          marker = list.length === 1000 ? list.at(-1).id : null;
        } while (marker && rules.length < 5000);
        return { version: '', rules };
      },
      async add(group, rule) {
        const option = new SDK.CreateSecurityGroupRuleOption()
          .withSecurityGroupId(group)
          .withDirection(rule.direction)
          .withEthertype(isIP(rule.cidr.split('/')[0]) === 6 ? 'IPv6' : 'IPv4')
          .withProtocol(rule.protocol)
          .withPortRangeMin(rule.from)
          .withPortRangeMax(rule.to)
          .withRemoteIpPrefix(rule.cidr)
          .withDescription(rule.description || 'Server Harbor');
        return client.createSecurityGroupRule(
          new SDK.CreateSecurityGroupRuleRequest().withBody(
            new SDK.CreateSecurityGroupRuleRequestBody().withSecurityGroupRule(option),
          ),
        );
      },
      async remove(group, rule) {
        return client.deleteSecurityGroupRule(
          new SDK.DeleteSecurityGroupRuleRequest().withSecurityGroupRuleId(rule.id),
        );
      },
    };
  }
  throw Object.assign(new Error('Unsupported provider'), { code: 'UNSUPPORTED_PROVIDER' });
}
