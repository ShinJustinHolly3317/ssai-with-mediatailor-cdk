import { LiveInfraStackProps } from '../lib/live-infra-stack';
import { stagingLiveInfraStackProps } from './staging';
import { productionLiveInfraStackProps } from './production';

const NODE_ENV = process.env.NODE_ENV || 'staging';

export type envMode = 'staging' | 'production';

export enum Account {
  WestWild = '',
  Main = '',
  ECV = '',
}

export enum LIVE_MODE {
  SSAI = 'ssai',
  LIVE = 'live',
}

export const basicStackName = 'InfraStack';

export const CDN_POLICIES = {
  requestPolicies: {
    allViewers: '216adef6-5c7f-47e4-b989-5492eafa07d3',
  },
  cachePolicies: {
    disabled: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
    managedElementalMediaPackage: '08627262-05a9-4f76-9ded-b50ca2e3a84f',
  },
  responsePolicies: {},
};

export const AdsUrl = {
  staging: '',
  production: ''
}

interface LiveInfraStackPropsMap {
  [key: string]: Omit<LiveInfraStackProps, 'env' | 'liveMode'>;
}

export const liveInfraStackBasicPropsMap: LiveInfraStackPropsMap = {
  staging: stagingLiveInfraStackProps,
  production: productionLiveInfraStackProps,
};

export default liveInfraStackBasicPropsMap[NODE_ENV];
