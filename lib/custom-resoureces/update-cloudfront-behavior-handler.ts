import {
  CloudFront,
  UpdateDistributionCommandInput,
  Origin,
  Origins,
  CacheBehaviors,
  CacheBehavior,
  DistributionConfig,
  GetDistributionConfigCommandOutput,
  DefaultCacheBehavior,
} from '@aws-sdk/client-cloudfront';
import {
  CdkCustomResourceEvent,
  CdkCustomResourceResponse,
  Context,
} from 'aws-lambda';
import { CDN_POLICIES } from '../../config';

// Only the 'handler' function uses an arrow function;
// the others use regular named functions.
export const handler = async (
  event: CdkCustomResourceEvent,
  context: Context,
): Promise<CdkCustomResourceResponse> => {
  try {
    const cf = new CloudFront();

    const mediaTailorOriginEndpoint =
      event.ResourceProperties.MEDIATAILOR_ORIGIN_ENDPOINT;
    const mediaPacakgeOriginEndpoint = event.ResourceProperties.MEDIAPACKAGE_ORIGIN_ENDPOINT;
    const distributionId = event.ResourceProperties.DISTRIBUTION_ID;
    const region = event.ResourceProperties.REGION;
    const mediaTailorAdSegmentOriginResponsePolicy =
      event.ResourceProperties.CORS_RESPONSE_HEADERS_POLICY;
    const mediaPackageOriginRequestPolicy =
      event.ResourceProperties.LIVE_INFRA_ORIGIN_REQUEST_POLICY;
    const cachePolicyId = event.ResourceProperties.CACHE_POLICY

    // 0. get distribution
    const curDistributionConfig = await cf.getDistributionConfig({
      Id: distributionId,
    });
    basicTypeGuard<DistributionConfig>(
      curDistributionConfig.DistributionConfig,
      'DistributionConfig',
    );
    basicTypeGuard<Origins>(
      curDistributionConfig.DistributionConfig.Origins,
      'Origins',
    );
    
    basicTypeGuard<CacheBehaviors>(
      curDistributionConfig.DistributionConfig.CacheBehaviors,
      'CacheBehaviors',
    );
    basicTypeGuard<DefaultCacheBehavior>(
      curDistributionConfig.DistributionConfig.DefaultCacheBehavior,
      'DefaultCacheBehavior',
    );
    
    const requestType = event['RequestType'];

    if (requestType === 'Delete') {
      curDistributionConfig.DistributionConfig!.CacheBehaviors = {
        Quantity: 0,
        Items: [],
      };
      curDistributionConfig.DistributionConfig!.Origins = {
        Quantity: 1,
        Items: [cdnOriginGenerator({
          originId: `${region}-media-tailor-segment-origin`,
          domainName: `segments.mediatailor.${region}.amazonaws.com`,
        })],
      };
      delete curDistributionConfig.DistributionConfig.DefaultCacheBehavior.ResponseHeadersPolicyId
      curDistributionConfig.DistributionConfig.DefaultCacheBehavior.OriginRequestPolicyId = CDN_POLICIES.requestPolicies.allViewers
      curDistributionConfig.DistributionConfig.DefaultCacheBehavior.CachePolicyId = CDN_POLICIES.cachePolicies.disabled
      const updateReqParam: UpdateDistributionCommandInput = {
        DistributionConfig: curDistributionConfig.DistributionConfig,
        IfMatch: curDistributionConfig.ETag,
        Id: distributionId,
      };
  
      console.log(
        'Final CacheBehaviors.Items',
        curDistributionConfig.DistributionConfig!.CacheBehaviors,
      );
      console.log(
        'Final Origins',
        curDistributionConfig.DistributionConfig!.Origins,
      );
      
      const updateDistributionRes = await cf.updateDistribution(updateReqParam);
      console.log('[updateDistributionRes]', updateDistributionRes);

      return {
        PhysicalResourceId: event.PhysicalResourceId,
        Status: 'SUCCESS',
      };
    }

    // 1. set default cache behavior and origin
    curDistributionConfig.DistributionConfig!.CacheBehaviors = {
      Quantity: 0,
      Items: [],
    };
    curDistributionConfig.DistributionConfig!.Origins = {
      Quantity: 1,
      Items: [cdnOriginGenerator({
        originId: `${region}-media-tailor-segment-origin`,
        domainName: `segments.mediatailor.${region}.amazonaws.com`,
      })],
    };
    curDistributionConfig.DistributionConfig.DefaultCacheBehavior.TargetOriginId = `${region}-media-tailor-segment-origin`;
    // 2. create MediaTailor cache behavior
    createCdnBehavior({
      curDistributionOrigins: curDistributionConfig.DistributionConfig.Origins,
      curDistributionCacheBehaviors: curDistributionConfig.DistributionConfig.CacheBehaviors,
      pathPattern: '/v1/*',
      originId: `${region}-media-tailor-origin`,
      cachePolicyId,
      requestPolicyId: CDN_POLICIES.requestPolicies.allViewers,
      originEndpoint: mediaTailorOriginEndpoint,
      responseHeadersPolicyId: mediaTailorAdSegmentOriginResponsePolicy,
    });
    // 3. create mediaPackage cache behavior
    createCdnBehavior({
      curDistributionOrigins: curDistributionConfig.DistributionConfig.Origins,
      curDistributionCacheBehaviors: curDistributionConfig.DistributionConfig.CacheBehaviors,
      pathPattern: '/out/v1/*',
      originId: `${region}-media-package-origin`,
      cachePolicyId,
      requestPolicyId: CDN_POLICIES.requestPolicies.allViewers,
      originEndpoint: mediaPacakgeOriginEndpoint,
      responseHeadersPolicyId: mediaTailorAdSegmentOriginResponsePolicy,
    });
    // 4. update default cache behavior
    changeDefaulBehaviorPolicy({
      curDistributionConfig,
      responseHeadersPolicyId: mediaTailorAdSegmentOriginResponsePolicy,
      requestPolicyId: mediaPackageOriginRequestPolicy,
      cachePolicyId,
    });

    const updateReqParam: UpdateDistributionCommandInput = {
      DistributionConfig: curDistributionConfig.DistributionConfig,
      IfMatch: curDistributionConfig.ETag,
      Id: distributionId,
    };

    console.log(
      'Final CacheBehaviors.Items',
      curDistributionConfig.DistributionConfig!.CacheBehaviors,
    );
    console.log(
      'Final Origins',
      curDistributionConfig.DistributionConfig!.Origins,
    );
    
    const updateDistributionRes = await cf.updateDistribution(updateReqParam);
    console.log('[updateDistributionRes]', updateDistributionRes);

    return {
      LogicalResourceId: event.LogicalResourceId,
      Status: 'SUCCESS',
    };
  } catch (err) {
    console.error('[update-cloudfront-behavior-handler error]', err);

    throw err;
  }
};

function createCdnBehavior(options: {
  curDistributionOrigins: Origins;
  curDistributionCacheBehaviors: CacheBehaviors;
  pathPattern: string;
  originId: string;
  cachePolicyId: string;
  requestPolicyId: string;
  responseHeadersPolicyId?: string;
  originEndpoint: string;
}) {
  const {
    curDistributionOrigins,
    curDistributionCacheBehaviors,
    pathPattern,
    originId,
    cachePolicyId,
    requestPolicyId,
    originEndpoint,
    responseHeadersPolicyId,
  } = options;

  basicTypeGuard<Number>(
    curDistributionOrigins.Quantity,
    'Origins.Quantity',
  );
  basicTypeGuard<Origin[]>(
    curDistributionOrigins.Items,
    'Origins.Items',
  );
  basicTypeGuard<Number>(
    curDistributionCacheBehaviors.Quantity,
    'CacheBehaviors.Quantity',
  );
  basicTypeGuard<CacheBehavior[]>(
    curDistributionCacheBehaviors.Items,
    'CacheBehaviors.Items',
  );

  // 1. Update mediaTailorOriginEndpoint
  const cdnOrigin = cdnOriginGenerator({
    originId: originId,
    domainName: originEndpoint,
  });
  curDistributionOrigins.Quantity =
  curDistributionOrigins.Quantity + 1;
  curDistributionOrigins.Items.push(
    cdnOrigin,
  );

  // 2. Update behavior
  const behaviorTemplate = cdnBehaviorGenerator({
    originId: originId,
    cachePolicyId: cachePolicyId || CDN_POLICIES.cachePolicies.disabled,
    originRequestPolicyId:
      requestPolicyId || CDN_POLICIES.requestPolicies.allViewers,
    responseHeadersPolicyId,
    pathPattern: pathPattern,
  });
  curDistributionCacheBehaviors.Quantity =
  curDistributionCacheBehaviors.Quantity + 1;
  curDistributionCacheBehaviors.Items.push(
    behaviorTemplate,
  );
}

/**
 * [type guard] type guard only allow normal function, not allow arrow function
 */
function basicTypeGuard<T>(obj: any, name: string): asserts obj is T {
  if (obj === undefined) throw new Error(`${name} is undefined`);
}

/**
 * Below functions is for readibility, not using arrow function
 */
function cdnOriginGenerator(options: {
  originId: string;
  domainName: string;
}): Origin {
  const mediaTailorKeepAliveTimeout = 58; // this is based on AWS support experiment https://support.console.aws.amazon.com/support/home?region=us-east-1#/case/?displayId=13844300041&language=zh

  return {
    Id: options.originId,
    DomainName: options.domainName, // "toBeRaplaced.mediatailor.ap-northeast-1.amazonaws.com"
    OriginPath: '',
    CustomHeaders: {
      Quantity: 1,
      Items: [
        {
          HeaderName: 'access-control-allow-origin',
          HeaderValue: '*',
        },
      ],
    },
    CustomOriginConfig: {
      HTTPPort: 80,
      HTTPSPort: 443,
      OriginProtocolPolicy: 'match-viewer',
      OriginSslProtocols: {
        Quantity: 1,
        Items: ['TLSv1.1'],
      },
      OriginReadTimeout: 30,
      OriginKeepaliveTimeout: options.domainName.includes('mediatailor') ? mediaTailorKeepAliveTimeout : 5,
    },
    ConnectionAttempts: 3,
    ConnectionTimeout: 10,
    OriginShield: {
      Enabled: false,
    },
    OriginAccessControlId: '',
  };
}

function cdnBehaviorGenerator(options: {
  pathPattern: string;
  originId: string;
  cachePolicyId: string;
  originRequestPolicyId: string;
  responseHeadersPolicyId?: string;
}): CacheBehavior {
  return {
    PathPattern: options.pathPattern,
    TargetOriginId: options.originId,
    TrustedSigners: {
      Enabled: false,
      Quantity: 0,
      Items: [],
    },
    TrustedKeyGroups: {
      Enabled: false,
      Quantity: 0,
      Items: [],
    },
    ViewerProtocolPolicy: 'https-only',
    AllowedMethods: {
      Quantity: 3,
      Items: ['HEAD', 'GET', 'OPTIONS'],
      CachedMethods: {
        Quantity: 2,
        Items: ['HEAD', 'GET'],
      },
    },
    SmoothStreaming: false,
    Compress: false,
    LambdaFunctionAssociations: {
      Quantity: 0,
      Items: [],
    },
    FunctionAssociations: {
      Quantity: 0,
      Items: [],
    },
    FieldLevelEncryptionId: '',
    CachePolicyId: options.cachePolicyId, // mediator "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    OriginRequestPolicyId: options.originRequestPolicyId, // "216adef6-5c7f-47e4-b989-5492eafa07d3"
    ResponseHeadersPolicyId: options.responseHeadersPolicyId,
  };
}

function changeDefaulBehaviorPolicy(options: {
  curDistributionConfig: GetDistributionConfigCommandOutput;
  requestPolicyId?: string;
  cachePolicyId?: string;
  responseHeadersPolicyId?: string;
}) {
  const {
    curDistributionConfig,
    requestPolicyId,
    cachePolicyId,
    responseHeadersPolicyId,
  } = options;
  basicTypeGuard<DistributionConfig>(
    curDistributionConfig.DistributionConfig,
    'DistributionConfig',
  );
  basicTypeGuard<DefaultCacheBehavior>(
    curDistributionConfig.DistributionConfig.DefaultCacheBehavior,
    'DefaultCacheBehavior',
  );

  if (requestPolicyId) {
    curDistributionConfig.DistributionConfig.DefaultCacheBehavior.OriginRequestPolicyId =
      requestPolicyId;
  }
  if (cachePolicyId) {
    curDistributionConfig.DistributionConfig.DefaultCacheBehavior.CachePolicyId =
      cachePolicyId;
  }
  if (responseHeadersPolicyId) {
    curDistributionConfig.DistributionConfig.DefaultCacheBehavior.ResponseHeadersPolicyId =
      responseHeadersPolicyId;
  }
}
