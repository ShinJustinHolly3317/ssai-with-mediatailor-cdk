import { LiveInfraStackProps } from '../lib/live-infra-stack';

export const productionLiveInfraStackProps: Omit<LiveInfraStackProps, 'env' | 'liveMode'> = {
  envMode: 'production',
  keyGroupId: '',
  whitelistCidrs: [],
  streamName: '',
  streamName2: '',
  enableEdgeLambdas: false,
};
