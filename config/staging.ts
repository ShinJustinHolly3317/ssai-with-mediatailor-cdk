import { LiveInfraStackProps } from '../lib/live-infra-stack';

export const stagingLiveInfraStackProps: Omit<LiveInfraStackProps, 'env' | 'liveMode'> = {
  envMode: 'staging',
  keyGroupId: '',
  whitelistCidrs: [],
  streamName: '',
  streamName2: '',
  enableEdgeLambdas: false,
};
