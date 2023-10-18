import {
  Stack,
  StackProps,
  Duration,
  Fn,
  RemovalPolicy,
  CustomResource,
} from 'aws-cdk-lib';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as medialive from 'aws-cdk-lib/aws-medialive';
import * as mediapackage from 'aws-cdk-lib/aws-mediapackage';
import * as mediatailor from 'aws-cdk-lib/aws-mediatailor';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { Account, LIVE_MODE, AdsUrl, envMode } from '../config';
import { firstCapitalCamel, kebabize } from '../utils';
import * as path from 'path';

export interface LiveInfraStackProps extends StackProps {
  envMode: envMode;
  liveMode: LIVE_MODE;
  keyGroupId: string;
  whitelistCidrs: string[];
  stackName?: string;
  streamName: string;
  streamName2: string;
  enableEdgeLambdas: boolean;
  env: {
    account: string;
    region: string;
  };
}

export class LiveInfraStack extends Stack {
  rtmpInputSg: medialive.CfnInputSecurityGroup;
  rtmpInput: medialive.CfnInput;
  packageChannel: mediapackage.CfnChannel;
  packageChannelEndpoint: mediapackage.CfnOriginEndpoint;
  describeMediaPackageChannelCustomResource: cr.AwsCustomResource;
  putPasswordParameterCustomResource: cr.AwsCustomResource;
  putPasswordParameterCustomResource2: cr.AwsCustomResource;
  medialiveRole: iam.Role;
  medialiveChannel: medialive.CfnChannel;
  mediaPackageOrigin: origins.HttpOrigin;
  mediaPackageOriginEndpoint: string;
  mediaTailorSegmentOrigin: origins.HttpOrigin;
  mediaTailor: mediatailor.CfnPlaybackConfiguration;
  mediaTailorOrigin: origins.HttpOrigin;
  liveCdnDistribution: cloudfront.Distribution;
  masterPlaylistEdgeLambdas: cloudfront.EdgeLambda[];
  childPlaylistEdgeLambdas: cloudfront.EdgeLambda[];
  tsEdgeLambdas: cloudfront.EdgeLambda[];
  responseHeadersPolicy: cloudfront.ResponseHeadersPolicy;
  mediaPackageOriginRequestPolicy: cloudfront.OriginRequestPolicy;
  cdnCachePolicy: cloudfront.CachePolicy;

  constructor(scope: Construct, id: string, props: LiveInfraStackProps) {
    super(scope, id, props);

    // these services created in the same region as the stack
    const rtmpInputName = `custom-${props.envMode}-${props.liveMode}-rtmp-push`;
    const liveChannelName = `custom-${props.envMode}-${props.liveMode}-channel`;
    const packageChannelId = `custom-${props.envMode}-${props.liveMode}-package-channel`;
    const packageChannelEndpointId = `custom-${props.envMode}-${props.liveMode}-package-channel-hls-endpoint`;

    // these services has no region, need to include in name to seperate different service
    const liveRoleName = `custom-${props.envMode}-${props.env.region}-${props.liveMode}-live-channel-role`;
    const mediaPackageInputPasswordName = `/medialive/${packageChannelId}/password`;
    const mediaPackageInputPasswordName2 = `/medialive/${packageChannelId}/password2`;

    const destinationRefId = `${packageChannelId}-destination`;

    // AsCustomResource only create one lambda, and use the same name for the following AsCustomResource lambdas
    // Therefore, all AsCustomResource lambdas shares the same name
    //
    // [Noted] This name CANNOT be changed after first deploy, due to it's part of cr service token(which is an ID how cr reconize a lambda)
    // REF: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.custom_resources.AwsCustomResource.html#functionname
    const awsCrHandlerName = `${props.stackName}-cr-handler`;

    // The code that defines your stack goes here
    this.prepareRtmpInputSg(props);
    this.prepareRtmpInput(rtmpInputName, props);
    this.preparePackageChannel(packageChannelId, props);
    this.preparePackageChannelEndpoint(
      packageChannelEndpointId,
      packageChannelId,
      props,
    );

    this.prepareDescribeMediaPackageChannelCustomResource(
      awsCrHandlerName,
      packageChannelId,
      props,
    );
    this.prepareMediaPackageInputPasswords(
      awsCrHandlerName,
      mediaPackageInputPasswordName,
      mediaPackageInputPasswordName2,
      props,
    );

    this.prepareMediaLiveRole(liveRoleName, props);
    this.prepareMedialiveChannel(
      destinationRefId,
      mediaPackageInputPasswordName,
      mediaPackageInputPasswordName2,
      liveChannelName,
      props,
    );

    this.prepareMasterPlaylistEdgeLambdas(props);
    this.prepareChildPlaylistEdgeLambdas(props);
    this.prepareTsEdgeLambdas(props);

    // create LIVE CDN
    this.prepareMediaPackageOrigin(this.packageChannelEndpoint);
    this.preparecustomCorsResponseHeadersPolicy(props);
    this.prepareCdnCachePolicy(props);
  
    switch(props.liveMode) {
      case LIVE_MODE.LIVE:
        this.prepareLiveCdnDistribution(props);
        break
      case LIVE_MODE.SSAI:
        // create SSAI CDN
        this.createMediaTailorSegmentOrigin(props);
        this.prepareSsaiCdnDistribution(props);

        // create MediaTailor
        this.prepareMediaTailor(props);

        // use cr to update cloudfront behaviour
        this.updateCdnBehaviourOfMediaTailorManifest(props);
        break
      default:
        throw new Error('invalid live mode!')
    }
  }

  private prepareTsEdgeLambdas(props: LiveInfraStackProps) {
    const behavior = 'Ts';
    this.tsEdgeLambdas = [
      this.createEdgeLambda(
        behavior,
        cloudfront.LambdaEdgeEventType.VIEWER_REQUEST,
        props.envMode,
        props,
      ),
      this.createEdgeLambda(
        behavior,
        cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
        props.envMode,
        props,
      ),
      this.createEdgeLambda(
        behavior,
        cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE,
        props.envMode,
        props,
      ),
      this.createEdgeLambda(
        behavior,
        cloudfront.LambdaEdgeEventType.VIEWER_RESPONSE,
        props.envMode,
        props,
      ),
    ];
  }

  private prepareChildPlaylistEdgeLambdas(props: LiveInfraStackProps) {
    const behavior = 'ChildPlaylist';
    this.childPlaylistEdgeLambdas = [
      this.createEdgeLambda(
        behavior,
        cloudfront.LambdaEdgeEventType.VIEWER_REQUEST,
        props.envMode,
        props,
      ),
      this.createEdgeLambda(
        behavior,
        cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
        props.envMode,
        props,
      ),
      this.createEdgeLambda(
        behavior,
        cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE,
        props.envMode,
        props,
      ),
      this.createEdgeLambda(
        behavior,
        cloudfront.LambdaEdgeEventType.VIEWER_RESPONSE,
        props.envMode,
        props,
      ),
    ];
  }

  private prepareMasterPlaylistEdgeLambdas(props: LiveInfraStackProps) {
    const behavior = 'MasterPlaylist';
    this.masterPlaylistEdgeLambdas = [
      this.createEdgeLambda(
        behavior,
        cloudfront.LambdaEdgeEventType.VIEWER_REQUEST,
        props.envMode,
        props,
      ),
      this.createEdgeLambda(
        behavior,
        cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
        props.envMode,
        props,
      ),
      this.createEdgeLambda(
        behavior,
        cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE,
        props.envMode,
        props,
      ),
      this.createEdgeLambda(
        behavior,
        cloudfront.LambdaEdgeEventType.VIEWER_RESPONSE,
        props.envMode,
        props,
      ),
    ];
  }

  private createEdgeLambda(
    behaviorType: string,
    eventType: cloudfront.LambdaEdgeEventType,
    envMode: envMode,
    props: LiveInfraStackProps,
  ) {
    const logicalId = `${behaviorType}${firstCapitalCamel(eventType)}${
      props.liveMode
    }LambdaEdge`;
    const functionName = `${kebabize(behaviorType)}-${eventType}-${envMode}-${
      props.liveMode
    }-lambda-edge`;

    const handler = new cloudfront.experimental.EdgeFunction(this, logicalId, {
      runtime: lambda.Runtime.NODEJS_16_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
exports.handler = async (event, context, callback) => {
  const request = event.Records[0].cf.request;
  const response = event.Records[0].cf.response;

  console.log('event =', JSON.stringify(event, null, 2));
  console.log('request =', JSON.stringify(request, null, 2));
  console.log('response =', JSON.stringify(response, null, 2));

  if (response) {
    callback(null, response);
    return;
  }

  callback(null, request);
};
      `),
      functionName,
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });

    return {
      eventType,
      functionVersion: handler.currentVersion,
    };
  }

  private prepareLiveCdnDistribution(props: LiveInfraStackProps) {
    this.mediaPackageOriginRequestPolicy = new cloudfront.OriginRequestPolicy(
      this,
      `${props.envMode}-${props.env.region}-${props.liveMode}-MediaPackageOriginRequestPolicy`,
      {
        originRequestPolicyName: `${props.envMode}-${props.env.region}-${props.liveMode}-media-package-origin-request-policy`,
        queryStringBehavior:
          cloudfront.OriginRequestQueryStringBehavior.allowList(
            'start',
            'end',
            'm',
          ),
        cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
        headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
          ...[
            'Origin',
            'CloudFront-Is-Tablet-Viewer',
            'CloudFront-Is-Mobile-Viewer',
            'CloudFront-Is-SmartTV-Viewer',
            'CloudFront-Is-Desktop-Viewer',
          ],
        ),
      },
    );

    this.liveCdnDistribution = new cloudfront.Distribution(this, 'LiveCDN', {
      additionalBehaviors: {
        'index.ism/*': {
          origin: this.mediaPackageOrigin,
          compress: false,
          allowedMethods:
            cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: this.cdnCachePolicy,
          originRequestPolicy: this.mediaPackageOriginRequestPolicy,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          edgeLambdas: props.enableEdgeLambdas
            ? this.tsEdgeLambdas
            : undefined,
        },
      },
      defaultBehavior: {
        origin: this.mediaPackageOrigin,
        compress: false,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: this.cdnCachePolicy,
        originRequestPolicy: this.mediaPackageOriginRequestPolicy,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        edgeLambdas: props.enableEdgeLambdas ? this.tsEdgeLambdas : undefined,
      },
      comment: `custom ${firstCapitalCamel(props.envMode)} ${
        props.liveMode
      } Live CDN`,
      /**
       * custom-cloudfront-log at chocolabs aws account.
       */
      logBucket: s3.Bucket.fromBucketArn(
        this,
        'CloudfrontLogBucket',
        `arn:aws:s3:::custom-cloudfront-log${
          this.account === Account.WestWild ? '-westwild' : ''
        }`,
      ),
      logFilePrefix: `live/custom-live-${props.envMode}`,
      errorResponses: [
        {
          ttl: Duration.seconds(1),
          httpStatus: 400,
        },
        {
          ttl: Duration.seconds(1),
          httpStatus: 403,
        },
        {
          ttl: Duration.seconds(1),
          httpStatus: 404,
        },
        {
          ttl: Duration.seconds(1),
          httpStatus: 405,
        },
        {
          ttl: Duration.seconds(1),
          httpStatus: 414,
        },
        {
          ttl: Duration.seconds(1),
          httpStatus: 416,
        },
        {
          ttl: Duration.seconds(1),
          httpStatus: 500,
        },
        {
          ttl: Duration.seconds(1),
          httpStatus: 501,
        },
        {
          ttl: Duration.seconds(1),
          httpStatus: 502,
        },
        {
          ttl: Duration.seconds(1),
          httpStatus: 503,
        },
        {
          ttl: Duration.seconds(1),
          httpStatus: 504,
        },
      ],
    });

    this.liveCdnDistribution.node.addDependency(this.packageChannelEndpoint);
  }

  private prepareSsaiCdnDistribution(props: LiveInfraStackProps) {
    this.mediaPackageOriginRequestPolicy = new cloudfront.OriginRequestPolicy(
      this,
      `${props.envMode}-${props.env.region}-${props.liveMode}-MediaPackageOriginRequestPolicy`,
      {
        originRequestPolicyName: `${props.envMode}-${props.env.region}-${props.liveMode}-media-package-origin-request-policy`,
        queryStringBehavior:
          cloudfront.OriginRequestQueryStringBehavior.allowList(
            'start',
            'end',
            'm',
          ),
        cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
        headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
          ...[
            'Origin',
            'CloudFront-Is-Tablet-Viewer',
            'CloudFront-Is-Mobile-Viewer',
            'CloudFront-Is-SmartTV-Viewer',
            'CloudFront-Is-Desktop-Viewer',
          ],
        ),
      },
    );

    this.liveCdnDistribution = new cloudfront.Distribution(this, 'LiveCDN', {
      defaultBehavior: {
        origin: this.mediaTailorSegmentOrigin,
        compress: false,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: this.mediaPackageOriginRequestPolicy,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        edgeLambdas: props.enableEdgeLambdas ? this.tsEdgeLambdas : undefined,
      },
      comment: `custom ${firstCapitalCamel(props.envMode)} ${
        props.liveMode
      } Live CDN`,
      /**
       * custom-cloudfront-log at chocolabs aws account.
       */
      logBucket: s3.Bucket.fromBucketArn(
        this,
        'CloudfrontLogBucket',
        `arn:aws:s3:::custom-cloudfront-log${
          this.account === Account.WestWild ? '-westwild' : ''
        }`,
      ),
      logFilePrefix: `live/custom-live-${props.envMode}`,
      errorResponses: [
        {
          ttl: Duration.seconds(1),
          httpStatus: 400,
        },
        {
          ttl: Duration.seconds(1),
          httpStatus: 403,
        },
        {
          ttl: Duration.seconds(1),
          httpStatus: 404,
        },
        {
          ttl: Duration.seconds(1),
          httpStatus: 405,
        },
        {
          ttl: Duration.seconds(1),
          httpStatus: 414,
        },
        {
          ttl: Duration.seconds(1),
          httpStatus: 416,
        },
        {
          ttl: Duration.seconds(1),
          httpStatus: 500,
        },
        {
          ttl: Duration.seconds(1),
          httpStatus: 501,
        },
        {
          ttl: Duration.seconds(1),
          httpStatus: 502,
        },
        {
          ttl: Duration.seconds(1),
          httpStatus: 503,
        },
        {
          ttl: Duration.seconds(1),
          httpStatus: 504,
        },
      ],
    });

    this.liveCdnDistribution.node.addDependency(this.packageChannelEndpoint);
  }

  private prepareMediaPackageOrigin(
    mediaPackageDomain: mediapackage.CfnOriginEndpoint,
  ) {
    this.mediaPackageOrigin = new origins.HttpOrigin(
      Fn.select(2, Fn.split('/', mediaPackageDomain.getAtt('Url').toString())),
      {
        protocolPolicy: cloudfront.OriginProtocolPolicy.MATCH_VIEWER,
        httpsPort: 443,
        originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_1],
        originShieldEnabled: false,
        connectionAttempts: 3,
        connectionTimeout: Duration.seconds(10),
        readTimeout: Duration.seconds(30),
        keepaliveTimeout: Duration.seconds(5),
        customHeaders: {
          'access-control-allow-origin': '*',
        },
      },
    );
    this.mediaPackageOriginEndpoint = Fn.select(
      2,
      Fn.split('/', mediaPackageDomain.getAtt('Url').toString()),
    );
  }

  private prepareMedialiveChannel(
    destinationRefId: string,
    mediaPackageInputPasswordName: string,
    mediaPackageInputPasswordName2: string,
    liveChannelName: string,
    props: LiveInfraStackProps,
  ) {
    this.medialiveChannel = new medialive.CfnChannel(
      this,
      `${props.envMode}-${props.env.region}-${props.liveMode}-MediaLiveChannel`,
      {
        channelClass: 'STANDARD',
        destinations: [
          {
            id: destinationRefId,
            mediaPackageSettings: [],
            settings: [
              {
                passwordParam: mediaPackageInputPasswordName,
                url: this.describeMediaPackageChannelCustomResource.getResponseField(
                  'HlsIngest.IngestEndpoints.0.Url',
                ),
                username:
                  this.describeMediaPackageChannelCustomResource.getResponseField(
                    'HlsIngest.IngestEndpoints.0.Username',
                  ),
              },
              {
                passwordParam: mediaPackageInputPasswordName2,
                url: this.describeMediaPackageChannelCustomResource.getResponseField(
                  'HlsIngest.IngestEndpoints.1.Url',
                ),
                username:
                  this.describeMediaPackageChannelCustomResource.getResponseField(
                    'HlsIngest.IngestEndpoints.1.Username',
                  ),
              },
            ],
          },
        ],
        encoderSettings: {
          availConfiguration: {
            availSettings: {
              scte35SpliceInsert: {
                noRegionalBlackoutFlag: 'IGNORE',
                webDeliveryAllowedFlag: 'IGNORE',
              },
            },
          },
          audioDescriptions: [
            {
              audioSelectorName: 'Default',
              audioTypeControl: 'FOLLOW_INPUT',
              codecSettings: {
                aacSettings: {
                  bitrate: 192000,
                  codingMode: 'CODING_MODE_2_0',
                  inputType: 'NORMAL',
                  profile: 'LC',
                  rateControlMode: 'CBR',
                  rawFormat: 'NONE',
                  sampleRate: 48000,
                  spec: 'MPEG4',
                },
              },
              languageCodeControl: 'FOLLOW_INPUT',
              name: 'audio_1',
            },
            {
              audioSelectorName: 'Default',
              audioTypeControl: 'FOLLOW_INPUT',
              codecSettings: {
                aacSettings: {
                  bitrate: 192000,
                  codingMode: 'CODING_MODE_2_0',
                  inputType: 'NORMAL',
                  profile: 'LC',
                  rateControlMode: 'CBR',
                  rawFormat: 'NONE',
                  sampleRate: 48000,
                  spec: 'MPEG4',
                },
              },
              languageCodeControl: 'FOLLOW_INPUT',
              name: 'audio_2',
            },
            {
              audioSelectorName: 'Default',
              audioTypeControl: 'FOLLOW_INPUT',
              codecSettings: {
                aacSettings: {
                  bitrate: 128000,
                  codingMode: 'CODING_MODE_2_0',
                  inputType: 'NORMAL',
                  profile: 'LC',
                  rateControlMode: 'CBR',
                  rawFormat: 'NONE',
                  sampleRate: 48000,
                  spec: 'MPEG4',
                },
              },
              languageCodeControl: 'FOLLOW_INPUT',
              name: 'audio_3',
            },
            {
              audioSelectorName: 'Default',
              audioTypeControl: 'FOLLOW_INPUT',
              codecSettings: {
                aacSettings: {
                  bitrate: 128000,
                  codingMode: 'CODING_MODE_2_0',
                  inputType: 'NORMAL',
                  profile: 'LC',
                  rateControlMode: 'CBR',
                  rawFormat: 'NONE',
                  sampleRate: 48000,
                  spec: 'MPEG4',
                },
              },
              languageCodeControl: 'FOLLOW_INPUT',
              name: 'audio_4',
            },
          ],
          captionDescriptions: [],
          globalConfiguration: {
            inputEndAction: 'NONE',
            outputLockingMode: 'PIPELINE_LOCKING',
            outputTimingSource: 'INPUT_CLOCK',
            supportLowFramerateInputs: 'DISABLED',
          },
          outputGroups: [
            {
              name: 'HD',
              outputGroupSettings: {
                hlsGroupSettings: {
                  adMarkers: ['ELEMENTAL_SCTE35'],
                  captionLanguageMappings: [],
                  captionLanguageSetting: 'OMIT',
                  clientCache: 'ENABLED',
                  codecSpecification: 'RFC_4281',
                  destination: {
                    destinationRefId: destinationRefId,
                  },
                  directoryStructure: 'SINGLE_DIRECTORY',
                  hlsCdnSettings: {
                    hlsWebdavSettings: {
                      connectionRetryInterval: 1,
                      filecacheDuration: 300,
                      httpTransferMode: 'NON_CHUNKED',
                      numRetries: 10,
                      restartDelay: 15,
                    },
                  },
                  iFrameOnlyPlaylists: 'DISABLED',
                  indexNSegments: 10,
                  inputLossAction: 'PAUSE_OUTPUT',
                  ivInManifest: 'INCLUDE',
                  ivSource: 'FOLLOWS_SEGMENT_NUMBER',
                  keepSegments: 21,
                  manifestCompression: 'NONE',
                  manifestDurationFormat: 'FLOATING_POINT',
                  mode: 'LIVE',
                  outputSelection: 'MANIFESTS_AND_SEGMENTS',
                  programDateTime: 'EXCLUDE',
                  programDateTimePeriod: 600,
                  redundantManifest: 'DISABLED',
                  segmentLength: 6,
                  segmentationMode: 'USE_SEGMENT_DURATION',
                  segmentsPerSubdirectory: 10000,
                  streamInfResolution: 'INCLUDE',
                  timedMetadataId3Frame: 'PRIV',
                  timedMetadataId3Period: 10,
                  tsFileMode: 'SEGMENTED_FILES',
                },
              },
              outputs: [
                {
                  audioDescriptionNames: ['audio_1'],
                  captionDescriptionNames: [],
                  outputSettings: {
                    hlsOutputSettings: {
                      h265PackagingType: 'HVC1',
                      hlsSettings: {
                        standardHlsSettings: {
                          audioRenditionSets: 'PROGRAM_AUDIO',
                          m3U8Settings: {
                            audioFramesPerPes: 4,
                            audioPids: '492-498',
                            ecmPid: '8182',
                            nielsenId3Behavior: 'NO_PASSTHROUGH',
                            pcrControl: 'PCR_EVERY_PES_PACKET',
                            pmtPid: '480',
                            programNum: 1,
                            scte35Behavior: 'NO_PASSTHROUGH',
                            scte35Pid: '500',
                            timedMetadataBehavior: 'NO_PASSTHROUGH',
                            timedMetadataPid: '502',
                            videoPid: '481',
                          },
                        },
                      },
                      nameModifier: '_1080p30',
                    },
                  },
                  videoDescriptionName: 'video_1080p30',
                },
                {
                  audioDescriptionNames: ['audio_2'],
                  captionDescriptionNames: [],
                  outputSettings: {
                    hlsOutputSettings: {
                      hlsSettings: {
                        standardHlsSettings: {
                          audioRenditionSets: 'PROGRAM_AUDIO',
                          m3U8Settings: {
                            audioFramesPerPes: 4,
                            audioPids: '492-498',
                            ecmPid: '8182',
                            pcrControl: 'PCR_EVERY_PES_PACKET',
                            pmtPid: '480',
                            programNum: 1,
                            scte35Behavior: 'NO_PASSTHROUGH',
                            scte35Pid: '500',
                            timedMetadataBehavior: 'NO_PASSTHROUGH',
                            timedMetadataPid: '502',
                            videoPid: '481',
                          },
                        },
                      },
                      nameModifier: '_720p30',
                    },
                  },
                  videoDescriptionName: 'video_720p30',
                },
                {
                  audioDescriptionNames: ['audio_3'],
                  captionDescriptionNames: [],
                  outputSettings: {
                    hlsOutputSettings: {
                      hlsSettings: {
                        standardHlsSettings: {
                          audioRenditionSets: 'PROGRAM_AUDIO',
                          m3U8Settings: {
                            audioFramesPerPes: 4,
                            audioPids: '492-498',
                            ecmPid: '8182',
                            pcrControl: 'PCR_EVERY_PES_PACKET',
                            pmtPid: '480',
                            programNum: 1,
                            scte35Behavior: 'NO_PASSTHROUGH',
                            scte35Pid: '500',
                            timedMetadataBehavior: 'NO_PASSTHROUGH',
                            timedMetadataPid: '502',
                            videoPid: '481',
                          },
                        },
                      },
                      nameModifier: '_480p30',
                    },
                  },
                  videoDescriptionName: 'video_480p30',
                },
                {
                  audioDescriptionNames: ['audio_4'],
                  captionDescriptionNames: [],
                  outputSettings: {
                    hlsOutputSettings: {
                      hlsSettings: {
                        standardHlsSettings: {
                          audioRenditionSets: 'PROGRAM_AUDIO',
                          m3U8Settings: {
                            audioFramesPerPes: 4,
                            audioPids: '492-498',
                            ecmPid: '8182',
                            pcrControl: 'PCR_EVERY_PES_PACKET',
                            pmtPid: '480',
                            programNum: 1,
                            scte35Behavior: 'NO_PASSTHROUGH',
                            scte35Pid: '500',
                            timedMetadataBehavior: 'NO_PASSTHROUGH',
                            timedMetadataPid: '502',
                            videoPid: '481',
                          },
                        },
                      },
                      nameModifier: '_360p30',
                    },
                  },
                  videoDescriptionName: 'video_360p30',
                },
              ],
            },
          ],
          timecodeConfig: {
            source: 'EMBEDDED',
          },
          videoDescriptions: [
            {
              codecSettings: {
                h264Settings: {
                  adaptiveQuantization: 'HIGH',
                  afdSignaling: 'NONE',
                  bitrate: 8000000,
                  colorMetadata: 'INSERT',
                  entropyEncoding: 'CABAC',
                  flickerAq: 'ENABLED',
                  forceFieldPictures: 'DISABLED',
                  framerateControl: 'SPECIFIED',
                  framerateDenominator: 1,
                  framerateNumerator: 30,
                  gopBReference: 'ENABLED',
                  gopClosedCadence: 1,
                  gopNumBFrames: 3,
                  gopSize: 60,
                  gopSizeUnits: 'FRAMES',
                  level: 'H264_LEVEL_AUTO',
                  lookAheadRateControl: 'HIGH',
                  numRefFrames: 3,
                  parControl: 'INITIALIZE_FROM_SOURCE',
                  profile: 'HIGH',
                  rateControlMode: 'CBR',
                  scanType: 'PROGRESSIVE',
                  sceneChangeDetect: 'ENABLED',
                  slices: 1,
                  spatialAq: 'ENABLED',
                  subgopLength: 'FIXED',
                  syntax: 'DEFAULT',
                  temporalAq: 'ENABLED',
                  timecodeInsertion: 'DISABLED',
                },
              },
              height: 1080,
              name: 'video_1080p30',
              respondToAfd: 'NONE',
              scalingBehavior: 'DEFAULT',
              sharpness: 50,
              width: 1920,
            },
            {
              codecSettings: {
                h264Settings: {
                  adaptiveQuantization: 'HIGH',
                  afdSignaling: 'NONE',
                  bitrate: 3000000,
                  colorMetadata: 'INSERT',
                  entropyEncoding: 'CABAC',
                  flickerAq: 'ENABLED',
                  framerateControl: 'SPECIFIED',
                  framerateDenominator: 1,
                  framerateNumerator: 30,
                  gopBReference: 'ENABLED',
                  gopClosedCadence: 1,
                  gopNumBFrames: 3,
                  gopSize: 60,
                  gopSizeUnits: 'FRAMES',
                  level: 'H264_LEVEL_AUTO',
                  lookAheadRateControl: 'HIGH',
                  numRefFrames: 3,
                  parControl: 'INITIALIZE_FROM_SOURCE',
                  profile: 'HIGH',
                  rateControlMode: 'CBR',
                  scanType: 'PROGRESSIVE',
                  sceneChangeDetect: 'ENABLED',
                  slices: 1,
                  spatialAq: 'ENABLED',
                  syntax: 'DEFAULT',
                  temporalAq: 'ENABLED',
                  timecodeInsertion: 'DISABLED',
                },
              },
              height: 720,
              name: 'video_720p30',
              respondToAfd: 'NONE',
              scalingBehavior: 'DEFAULT',
              sharpness: 100,
              width: 1280,
            },
            {
              codecSettings: {
                h264Settings: {
                  adaptiveQuantization: 'HIGH',
                  afdSignaling: 'NONE',
                  bitrate: 1500000,
                  colorMetadata: 'INSERT',
                  entropyEncoding: 'CABAC',
                  flickerAq: 'ENABLED',
                  framerateControl: 'SPECIFIED',
                  framerateDenominator: 1,
                  framerateNumerator: 30,
                  gopBReference: 'ENABLED',
                  gopClosedCadence: 1,
                  gopNumBFrames: 3,
                  gopSize: 60,
                  gopSizeUnits: 'FRAMES',
                  level: 'H264_LEVEL_AUTO',
                  lookAheadRateControl: 'HIGH',
                  numRefFrames: 3,
                  parControl: 'INITIALIZE_FROM_SOURCE',
                  profile: 'MAIN',
                  rateControlMode: 'CBR',
                  scanType: 'PROGRESSIVE',
                  sceneChangeDetect: 'ENABLED',
                  slices: 1,
                  spatialAq: 'ENABLED',
                  subgopLength: 'FIXED',
                  syntax: 'DEFAULT',
                  temporalAq: 'ENABLED',
                  timecodeInsertion: 'DISABLED',
                },
              },
              height: 480,
              name: 'video_480p30',
              respondToAfd: 'NONE',
              scalingBehavior: 'DEFAULT',
              sharpness: 100,
              width: 852,
            },
            {
              codecSettings: {
                h264Settings: {
                  adaptiveQuantization: 'HIGH',
                  afdSignaling: 'NONE',
                  bitrate: 750000,
                  colorMetadata: 'INSERT',
                  entropyEncoding: 'CABAC',
                  flickerAq: 'ENABLED',
                  framerateControl: 'SPECIFIED',
                  framerateDenominator: 1,
                  framerateNumerator: 30,
                  gopBReference: 'ENABLED',
                  gopClosedCadence: 1,
                  gopNumBFrames: 3,
                  gopSize: 60,
                  gopSizeUnits: 'FRAMES',
                  level: 'H264_LEVEL_AUTO',
                  lookAheadRateControl: 'HIGH',
                  numRefFrames: 3,
                  parControl: 'INITIALIZE_FROM_SOURCE',
                  profile: 'MAIN',
                  rateControlMode: 'CBR',
                  scanType: 'PROGRESSIVE',
                  sceneChangeDetect: 'ENABLED',
                  slices: 1,
                  spatialAq: 'ENABLED',
                  subgopLength: 'FIXED',
                  syntax: 'DEFAULT',
                  temporalAq: 'ENABLED',
                  timecodeInsertion: 'DISABLED',
                },
              },
              height: 360,
              name: 'video_360p30',
              respondToAfd: 'NONE',
              scalingBehavior: 'DEFAULT',
              sharpness: 100,
              width: 640,
            },
          ],
        },
        inputAttachments: [
          {
            inputAttachmentName: `${this.rtmpInput.name}`,
            inputId: `${this.rtmpInput.ref}`,
            inputSettings: {
              audioSelectors: [],
              captionSelectors: [],
              deblockFilter: 'DISABLED',
              denoiseFilter: 'DISABLED',
              filterStrength: 1,
              inputFilter: 'AUTO',
              smpte2038DataPreference: 'IGNORE',
              sourceEndBehavior: 'CONTINUE',
            },
          },
        ],
        inputSpecification: {
          codec: 'AVC',
          maximumBitrate: 'MAX_20_MBPS',
          resolution: 'HD',
        },
        logLevel: 'DEBUG',
        name: liveChannelName,
        roleArn: `${this.medialiveRole.roleArn}`,
        tags: {},
      },
    );

    this.medialiveChannel.node.addDependency(this.rtmpInputSg);
    this.medialiveChannel.node.addDependency(this.rtmpInput);
    this.medialiveChannel.node.addDependency(this.packageChannel);
    this.medialiveChannel.node.addDependency(this.packageChannelEndpoint);
    this.medialiveChannel.node.addDependency(this.medialiveRole);
    this.medialiveChannel.node.addDependency(
      this.putPasswordParameterCustomResource,
    );
    this.medialiveChannel.node.addDependency(
      this.putPasswordParameterCustomResource2,
    );
  }

  private prepareMediaPackageInputPasswords(
    awsCrHandlerName: string,
    mediaPackageInputPasswordName: string,
    mediaPackageInputPasswordName2: string,
    props: LiveInfraStackProps,
  ) {
    this.putPasswordParameterCustomResource = new cr.AwsCustomResource(
      this,
      `${props.envMode}-${props.env.region}-${props.liveMode}-CreatePasswordInSSMCustomResource`,
      {
        functionName: awsCrHandlerName,
        logRetention: logs.RetentionDays.ONE_DAY,
        onCreate: {
          service: 'SSM',
          action: 'putParameter',
          parameters: {
            Name: mediaPackageInputPasswordName,
            Value:
              this.describeMediaPackageChannelCustomResource.getResponseField(
                'HlsIngest.IngestEndpoints.0.Password',
              ),
            Type: 'SecureString',
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            mediaPackageInputPasswordName,
          ),
        },
        onUpdate: {
          service: 'SSM',
          action: 'putParameter',
          parameters: {
            Name: mediaPackageInputPasswordName,
            Value:
              this.describeMediaPackageChannelCustomResource.getResponseField(
                'HlsIngest.IngestEndpoints.0.Password',
              ),
            Type: 'SecureString',
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            mediaPackageInputPasswordName,
          ),
        },
        onDelete: {
          service: 'SSM',
          action: 'deleteParameter',
          parameters: {
            Name: mediaPackageInputPasswordName,
          },
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
            resources: [
              `arn:aws:ssm:${this.region}:${this.account}:parameter${mediaPackageInputPasswordName}`,
            ],
          }),
        ]),
      },
    );

    this.putPasswordParameterCustomResource2 = new cr.AwsCustomResource(
      this,
      `${props.envMode}-${props.env.region}-${props.liveMode}-CreatePasswordInSSMCustomResource2`,
      {
        functionName: awsCrHandlerName,
        logRetention: logs.RetentionDays.ONE_DAY,
        onCreate: {
          service: 'SSM',
          action: 'putParameter',
          parameters: {
            Name: mediaPackageInputPasswordName2,
            Value:
              this.describeMediaPackageChannelCustomResource.getResponseField(
                'HlsIngest.IngestEndpoints.1.Password',
              ),
            Type: 'SecureString',
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            mediaPackageInputPasswordName2,
          ),
        },
        onUpdate: {
          service: 'SSM',
          action: 'putParameter',
          parameters: {
            Name: mediaPackageInputPasswordName2,
            Value:
              this.describeMediaPackageChannelCustomResource.getResponseField(
                'HlsIngest.IngestEndpoints.1.Password',
              ),
            Type: 'SecureString',
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            mediaPackageInputPasswordName2,
          ),
        },
        onDelete: {
          service: 'SSM',
          action: 'deleteParameter',
          parameters: {
            Name: mediaPackageInputPasswordName2,
          },
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
            resources: [
              `arn:aws:ssm:${this.region}:${this.account}:parameter${mediaPackageInputPasswordName2}`,
            ],
          }),
        ]),
      },
    );
  }

  private prepareDescribeMediaPackageChannelCustomResource(
    awsCrHandlerName: string,
    packageChannelId: string,
    props: LiveInfraStackProps,
  ) {
    this.describeMediaPackageChannelCustomResource = new cr.AwsCustomResource(
      this,
      `${props.envMode}-${props.env.region}-${props.liveMode}-DescribeMediaPackageChannelCustomResource`,
      {
        functionName: awsCrHandlerName,
        logRetention: logs.RetentionDays.ONE_DAY,
        onCreate: {
          service: 'MediaPackage',
          action: 'describeChannel',
          parameters: {
            Id: packageChannelId,
          },
          physicalResourceId: cr.PhysicalResourceId.fromResponse('Id'),
        },
        onUpdate: {
          service: 'MediaPackage',
          action: 'describeChannel',
          parameters: {
            Id: packageChannelId,
          },
          physicalResourceId: cr.PhysicalResourceId.fromResponse('Id'),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['mediapackage:DescribeChannel'],
            resources: ['*'],
          }),
        ]),
      },
    );
  }

  private preparePackageChannelEndpoint(
    packageChannelEndpointId: string,
    packageChannelId: string,
    props: LiveInfraStackProps,
  ) {
    this.packageChannelEndpoint = new mediapackage.CfnOriginEndpoint(
      this,
      `${props.envMode}-${props.env.region}-${props.liveMode}-PackageChannelEndpoint`,
      {
        id: packageChannelEndpointId,
        channelId: packageChannelId,
        hlsPackage: {
          adMarkers: 'PASSTHROUGH',
          adTriggers: [
            'SPLICE_INSERT',
            'PROVIDER_ADVERTISEMENT',
            'DISTRIBUTOR_ADVERTISEMENT',
            'PROVIDER_PLACEMENT_OPPORTUNITY',
            'DISTRIBUTOR_PLACEMENT_OPPORTUNITY',
          ],
          adsOnDeliveryRestrictions: 'RESTRICTED',
          includeIframeOnlyStream: false,
          playlistType: 'EVENT',
          playlistWindowSeconds: 60,
          programDateTimeIntervalSeconds: 0,
          segmentDurationSeconds: 6,
          streamSelection: {
            maxVideoBitsPerSecond: 2147483647,
            minVideoBitsPerSecond: 0,
            streamOrder: 'ORIGINAL',
          },
          useAudioRenditionGroup: false,
        },
      },
    );

    this.packageChannelEndpoint.node.addDependency(this.packageChannel);
  }

  private preparePackageChannel(
    packageChannelId: string,
    props: LiveInfraStackProps,
  ) {
    const egressAccessLogGroup = new logs.LogGroup(
      this,
      `${props.envMode}-${props.env.region}-${props.liveMode}-EgressAccessLogGroup`,
      {
        logGroupName: `/aws/MediaPackage/EgressAccessLogs${firstCapitalCamel(
          packageChannelId,
        )}-${props.liveMode}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy:
          this.account === Account.WestWild
            ? RemovalPolicy.DESTROY
            : RemovalPolicy.RETAIN,
      },
    );

    const ingressAccessLogGroup = new logs.LogGroup(
      this,
      `${props.envMode}-${props.env.region}-${props.liveMode}-IngressAccessLogGroup`,
      {
        logGroupName: `/aws/MediaPackage/IngressAccessLogs${firstCapitalCamel(
          packageChannelId,
        )}-${props.liveMode}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy:
          this.account === Account.WestWild
            ? RemovalPolicy.DESTROY
            : RemovalPolicy.RETAIN,
      },
    );

    this.packageChannel = new mediapackage.CfnChannel(
      this,
      `${props.envMode}-${props.env.region}-${props.liveMode}-PackageChannel`,
      {
        id: packageChannelId,
        egressAccessLogs: {
          logGroupName: egressAccessLogGroup.logGroupName,
        },
        ingressAccessLogs: {
          logGroupName: ingressAccessLogGroup.logGroupName,
        },
      },
    );

    this.packageChannel.node.addDependency(egressAccessLogGroup);
    this.packageChannel.node.addDependency(ingressAccessLogGroup);
  }

  private prepareRtmpInput(rtmpInputName: string, props: LiveInfraStackProps) {
    this.rtmpInput = new medialive.CfnInput(
      this,
      `${props.envMode}-${props.env.region}-${props.liveMode}-RtmpInput`,
      {
        name: rtmpInputName,
        inputSecurityGroups: [this.rtmpInputSg.ref],
        destinations: [
          {
            streamName: props.streamName,
          },
          {
            streamName: props.streamName2,
          },
        ],
        type: 'RTMP_PUSH',
      },
    );

    this.rtmpInput.node.addDependency(this.rtmpInputSg);
  }

  private prepareRtmpInputSg(props: LiveInfraStackProps) {
    this.rtmpInputSg = new medialive.CfnInputSecurityGroup(
      this,
      `${props.envMode}-${props.env.region}-${props.liveMode}-RtmpInputSg`,
      {
        whitelistRules: props.whitelistCidrs.map((cidr) => ({ cidr })),
      },
    );
  }

  private prepareMediaLiveRole(
    liveRoleName: string,
    props: LiveInfraStackProps,
  ) {
    this.medialiveRole = new iam.Role(
      this,
      `${props.envMode}-${props.env.region}-${props.liveMode}-MediaLiveRole`,
      {
        roleName: liveRoleName,
        assumedBy: new iam.ServicePrincipal('medialive.amazonaws.com'),
      },
    );

    this.medialiveRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3:ListBucket',
          's3:PutObject',
          's3:GetObject',
          's3:DeleteObject',
        ],
        resources: ['*'],
      }),
    );

    this.medialiveRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'mediastore:ListContainers',
          'mediastore:PutObject',
          'mediastore:GetObject',
          'mediastore:DeleteObject',
          'mediastore:DescribeObject',
        ],
        resources: ['*'],
      }),
    );

    this.medialiveRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:DescribeLogStreams',
          'logs:DescribeLogGroups',
        ],
        resources: ['arn:aws:logs:*:*:*'],
      }),
    );

    this.medialiveRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'mediaconnect:ManagedDescribeFlow',
          'mediaconnect:ManagedAddOutput',
          'mediaconnect:ManagedRemoveOutput',
        ],
        resources: ['*'],
      }),
    );

    this.medialiveRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'ec2:describeSubnets',
          'ec2:describeNetworkInterfaces',
          'ec2:createNetworkInterface',
          'ec2:createNetworkInterfacePermission',
          'ec2:deleteNetworkInterface',
          'ec2:deleteNetworkInterfacePermission',
          'ec2:describeSecurityGroups',
          'ec2:describeAddresses',
          'ec2:associateAddress',
        ],
        resources: ['*'],
      }),
    );

    this.medialiveRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['mediapackage:DescribeChannel'],
        resources: ['*'],
      }),
    );

    this.medialiveRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMReadOnlyAccess'),
    );
  }

  private prepareMediaTailor(props: LiveInfraStackProps) {
    this.mediaTailor = new mediatailor.CfnPlaybackConfiguration(
      this,
      `${props.envMode}-${props.env.region}-${props.liveMode}-MediaTailor`,
      {
        videoContentSourceUrl: Fn.select(
          0,
          Fn.split('index.m3u8', this.packageChannelEndpoint.attrUrl),
        ),
        adDecisionServerUrl: AdsUrl[props.envMode],
        name: `${this.account}-MediaTailor-${props.envMode}`,
        manifestProcessingRules: {
          adMarkerPassthrough: {
            enabled: true,
          },
        },
        cdnConfiguration: {
          contentSegmentUrlPrefix: `https://${
            this.liveCdnDistribution.distributionDomainName
          }/out/v1/${Fn.select(
            5,
            Fn.split('/', this.packageChannelEndpoint.attrUrl),
          )}`,
          adSegmentUrlPrefix: `https://${this.liveCdnDistribution.distributionDomainName}/`,
        },
      },
    );
  }

  private createMediaTailorSegmentOrigin(props: LiveInfraStackProps) {
    this.mediaTailorSegmentOrigin = new origins.HttpOrigin(
      `segments.mediatailor.${props.env.region}.amazonaws.com`,
      {
        protocolPolicy: cloudfront.OriginProtocolPolicy.MATCH_VIEWER,
        httpsPort: 443,
        originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_1],
        originShieldEnabled: false,
        connectionAttempts: 3,
        connectionTimeout: Duration.seconds(10),
        readTimeout: Duration.seconds(30),
        keepaliveTimeout: Duration.seconds(58),
        customHeaders: {
          'access-control-allow-origin': '*',
        },
      },
    );
  }

  /**
   * [Noted] This lambda logicalId CANNOT be changed after first deploy, due to it's part of cr service token(which is an ID how cr reconize a lambda)
   */
  private updateCdnBehaviourOfMediaTailorManifest(props: LiveInfraStackProps) {
    const fn = new NodejsFunction(
      this,
      `${props.env.region}-${props.liveMode}-Update-Cdn-Behaviour-handler-${props.envMode}`, // don't change this name after first deploy
      {
        entry: path.join(
          __dirname,
          './custom-resoureces/update-cloudfront-behavior-handler.ts',
        ),
        handler: 'handler',
        timeout: Duration.seconds(300),
        runtime: lambda.Runtime.NODEJS_18_X,
        initialPolicy: [
          new iam.PolicyStatement({
            actions: ['cloudfront:*'],
            resources: ['*'],
          }),
        ],
        logRetention: logs.RetentionDays.ONE_DAY,
      },
    );

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: fn,
    });

    new CustomResource(this, 'CdnResource', {
      serviceToken: provider.serviceToken,
      properties: {
        DISTRIBUTION_ID: this.liveCdnDistribution.distributionId,
        MEDIATAILOR_ORIGIN_ENDPOINT: Fn.select(
          2,
          Fn.split(
            '/',
            this.mediaTailor.attrHlsConfigurationManifestEndpointPrefix,
          ),
        ),
        MEDIAPACKAGE_ORIGIN_ENDPOINT: this.mediaPackageOriginEndpoint,
        REGION: props.env.region,
        CORS_RESPONSE_HEADERS_POLICY:
          this.responseHeadersPolicy.responseHeadersPolicyId,
        LIVE_INFRA_ORIGIN_REQUEST_POLICY:
          this.mediaPackageOriginRequestPolicy.originRequestPolicyId,
        CACHE_POLICY: cloudfront.CachePolicy.CACHING_DISABLED.cachePolicyId,
        randomNums: Math.random().toString(),
      },
    });
  }

  private preparecustomCorsResponseHeadersPolicy(props: LiveInfraStackProps) {
    this.responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      `${props.envMode}-${props.env.region}-${props.liveMode}-ResponseHeadersPolicy`,
      {
        responseHeadersPolicyName: `${props.envMode}-${props.env.region}-${props.liveMode}-custom-CORS-Response-Header-Policy`,
        corsBehavior: {
          accessControlAllowHeaders: [
            'Authorization',
            'Content-Type',
            'X-Amz-Date',
            'X-Amz-Security-Token',
            'X-Api-Key',
          ],
          accessControlAllowMethods: ['GET', 'HEAD', 'OPTIONS'],
          accessControlAllowOrigins: ['*'],
          accessControlAllowCredentials: true,
          originOverride: true,
        },
      },
    );
  }

  private prepareCdnCachePolicy(props: LiveInfraStackProps) {
    this.cdnCachePolicy = new cloudfront.CachePolicy(
      this,
      `${props.envMode}-${props.env.region}-${props.liveMode}-CachePolicy`,
      {
        cachePolicyName: `${props.envMode}-${props.env.region}-${props.liveMode}-LiveInfra-Cache-Policy`,
        defaultTtl: Duration.minutes(5),
        maxTtl: Duration.minutes(5),
        queryStringBehavior: cloudfront.CacheQueryStringBehavior.allowList(
          'start',
          'end',
          'm',
        ),
        headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
          'Origin',
          'CloudFront-Is-Tablet-Viewer',
          'CloudFront-Is-Mobile-Viewer',
          'CloudFront-Is-SmartTV-Viewer',
          'CloudFront-Is-Desktop-Viewer',
        ),
      },
    );
  }
}
