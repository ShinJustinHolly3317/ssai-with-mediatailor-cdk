#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { LiveInfraStack } from '../lib/live-infra-stack';
import liveInfraStackProps, { Account, LIVE_MODE, basicStackName } from '../config';
import { firstCapitalCamel } from '../utils';

const app = new App();
const name = `LiveOnly${firstCapitalCamel(liveInfraStackProps.envMode)}${basicStackName}`;

export const liveInfraStack = new LiveInfraStack(
  app,
  name,
  {
    env: {
      account: process.env.AWS_ACCOUNT || process.env.CDK_DEFAULT_ACCOUNT || Account.WestWild,
      region: process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'ap-north-east',
    },
    liveMode: LIVE_MODE.LIVE,
    ...liveInfraStackProps,
    stackName: name,
  },
);
