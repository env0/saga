import * as aws from '@pulumi/aws';
import * as awsx from '@pulumi/awsx/classic';
import { createHmac, timingSafeEqual } from 'crypto';

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
};

const githubOwner = requireEnv('GITHUB_OWNER');
const githubRepo = requireEnv('GITHUB_REPO');
const githubToken = requireEnv('GITHUB_TOKEN');
const slackSigningSecret = requireEnv('SLACK_SIGNING_SECRET');

const runtime = aws.lambda.Runtime.NodeJS24dX;

type SlackSlashCommand = {
  token: string;
  team_id: string;
  team_domain: string;
  enterprise_id: string;
  channel_id: string;
  channel_name: string;
  user_id: string;
  user_name: string;
  command: string;
  text: string;
  response_url: string;
  trigger_id: string;
  api_app_id: string;
};

const SLACK_MAX_REQUEST_AGE_SECONDS = 5 * 60;

const headerValue = (headers: awsx.apigateway.Request['headers'], name: string): string | undefined =>
  Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

const isSlackSignatureValid = ({
  rawBody,
  timestamp,
  signature,
  signingSecret
}: {
  rawBody: string;
  timestamp?: string;
  signature?: string;
  signingSecret: string;
}): boolean => {
  if (!timestamp || !signature) {
    return false;
  }

  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > SLACK_MAX_REQUEST_AGE_SECONDS) {
    return false;
  }

  const expected = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;

  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
};

const worker = new aws.lambda.CallbackFunction('saga-worker', {
  runtime,
  timeout: 30,
  environment: {
    variables: { GITHUB_OWNER: githubOwner, GITHUB_REPO: githubRepo, GITHUB_TOKEN: githubToken }
  },
  callback: async (command: SlackSlashCommand): Promise<void> => {
    const respondToSlack = async (text: string) => {
      const response = await fetch(command.response_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_type: 'ephemeral', text })
      });

      if (!response.ok) {
        console.error(`Slack response_url returned ${response.status}: ${await response.text()}`);
      }
    };

    try {
      const args = command.text?.trim().split(/\s+/).filter(Boolean) ?? [];
      const [eventType] = args;

      if (!eventType) {
        await respondToSlack(`Usage: ${command.command} <event> [args...]`);
        return;
      }

      const { GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN } = process.env;
      const response = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'saga',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        body: JSON.stringify({
          event_type: `saga-${eventType}`,
          client_payload: { command: command.command, user_name: command.user_name, args }
        })
      });

      if (!response.ok) {
        throw new Error(`GitHub dispatch failed with ${response.status}: ${await response.text()}`);
      }
    } catch (e) {
      console.error(e);
      await respondToSlack('Failed to trigger GitHub Actions - see saga cloudwatch logs for details');
    }
  }
});

const receiverRole = new aws.iam.Role('saga-receiver', {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'lambda.amazonaws.com' })
});

const receiverLogsPolicy = new aws.iam.RolePolicyAttachment('saga-receiver-logs', {
  role: receiverRole,
  policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole
});

const receiverInvokePolicy = new aws.iam.RolePolicy('saga-receiver-invoke-worker', {
  role: receiverRole,
  policy: {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: 'lambda:InvokeFunction', Resource: worker.arn }]
  }
});

// Slack shows "Something went wrong" unless the slash command is acknowledged within 3 seconds,
// so the receiver only verifies the request and hands the work off to the worker asynchronously.
const receiver = new aws.lambda.CallbackFunction(
  'saga',
  {
    runtime,
    role: receiverRole,
    timeout: 10,
    memorySize: 512,
    environment: {
      variables: { SLACK_SIGNING_SECRET: slackSigningSecret, WORKER_FUNCTION_NAME: worker.name }
    },
    callbackFactory: () => {
      // Resolved at runtime from the SDK bundled into the Lambda Node.js runtime, so it stays out of the deployment package.
      const { LambdaClient, InvokeCommand } =
        require('@aws-sdk/client-lambda') as typeof import('@aws-sdk/client-lambda');
      const lambda = new LambdaClient({});

      return async (event: awsx.apigateway.Request): Promise<awsx.apigateway.Response> => {
        const rawBody = event.isBase64Encoded
          ? Buffer.from(event.body ?? '', 'base64').toString('utf-8')
          : (event.body ?? '');

        const authorized = isSlackSignatureValid({
          rawBody,
          timestamp: headerValue(event.headers, 'X-Slack-Request-Timestamp'),
          signature: headerValue(event.headers, 'X-Slack-Signature'),
          signingSecret: process.env.SLACK_SIGNING_SECRET ?? ''
        });

        if (!authorized) {
          console.error('Rejected request with an invalid Slack signature');
          return { statusCode: 401, body: 'Invalid Slack signature' };
        }

        const command = Object.fromEntries(new URLSearchParams(rawBody)) as SlackSlashCommand;

        await lambda.send(
          new InvokeCommand({
            FunctionName: process.env.WORKER_FUNCTION_NAME,
            InvocationType: 'Event',
            Payload: JSON.stringify(command)
          })
        );

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ response_type: 'ephemeral', text: 'On it!' })
        };
      };
    }
  },
  { dependsOn: [receiverLogsPolicy, receiverInvokePolicy] }
);

const api = new awsx.apigateway.API('saga', {
  routes: [{ path: '', method: 'POST', eventHandler: receiver }]
});

export const endpoint = api.url;
