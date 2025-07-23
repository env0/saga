import * as aws from '@pulumi/aws';
import * as awsx from '@pulumi/awsx';
import * as querystring from 'querystring';
import axios from 'axios';
import { Octokit } from '@octokit/rest';
import { pick } from 'lodash';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

// Environment variables should be configured in your Pulumi stack or CI/CD environment
const owner = process.env.GITHUB_OWNER!;
const repo = process.env.GITHUB_REPO!;
const githubToken = process.env.GITHUB_TOKEN!;
const slackSigningSecret = process.env.SLACK_SIGNING_SECRET!;

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

// --- Helper for Slack Signature Verification ---
const authorize = ({
                     rawBody,
                     headers
                   }: {
  rawBody: string;
  headers: { [name: string]: string };
}) => {
  const signature = headers['X-Slack-Signature'];
  const timestamp = headers['X-Slack-Request-Timestamp'];

  if (!signature || !timestamp) {
    throw new Error('Missing Slack signature or timestamp headers');
  }

  // Prevent replay attacks
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 60 * 5) {
    throw new Error('Slack request timestamp is too old');
  }

  const crypto = require('crypto');
  const version = 'v0';
  const basestring = `${version}:${timestamp}:${rawBody}`;
  const hash = crypto.createHmac('sha256', slackSigningSecret).update(basestring).digest('hex');

  if (`${version}=${hash}` !== signature) {
    throw new Error('Slack signature verification failed');
  }
};

// --- Lambda #2: The Worker ---
// This function performs the long-running task of calling the GitHub API.
const workerLambda = new aws.lambda.CallbackFunction('saga-worker', {
  runtime: 'nodejs18.x',
  environment: {
    variables: {
      GITHUB_OWNER: owner,
      GITHUB_REPO: repo,
      GITHUB_TOKEN: githubToken
    }
  },
  callback: async (event: { Payload: string }) => {
    // The event payload is the stringified body from the first Lambda
    const body = JSON.parse(event.Payload) as SlackSlashCommand;

    const respondToSlack = (text: string) =>
      axios.post(body.response_url, {
        response_type: 'ephemeral',
        text
      });

    try {
      const args = body.text?.split(' ') || [];
      const eventType = args[0];

      await new Octokit({ auth: process.env.GITHUB_TOKEN }).rest.repos.createDispatchEvent({
        repo: process.env.GITHUB_REPO!,
        owner: process.env.GITHUB_OWNER!,
        event_type: `saga-${eventType}`,
        client_payload: { ...pick(body, 'command', 'user_name'), args }
      });

      await respondToSlack(`✅ Successfully triggered GitHub Action: \`${eventType}\``);
    } catch (e) {
      console.error(e);
      await respondToSlack('❌ Failed to trigger GitHub Action. Check CloudWatch logs for details.');
    }
  }
});

// --- IAM Role to allow the first Lambda to invoke the second ---
const acknowledgerRole = new aws.iam.Role('saga-ack-role', {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'lambda.amazonaws.com' })
});

new aws.iam.RolePolicyAttachment('saga-ack-role-lambda-basic', {
  role: acknowledgerRole,
  policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole
});

new aws.iam.RolePolicy('saga-ack-role-invoke-policy', {
  role: acknowledgerRole,
  policy: {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: 'lambda:InvokeFunction',
        Resource: workerLambda.arn
      }
    ]
  }
});

// --- Lambda #1: The Acknowledger ---
// This function receives the request from Slack, responds immediately,
// and triggers the worker Lambda asynchronously.
const acknowledgerLambda = new aws.lambda.CallbackFunction('saga-acknowledger', {
  runtime: 'nodejs18.x',
  role: acknowledgerRole,
  environment: {
    variables: {
      SLACK_SIGNING_SECRET: slackSigningSecret,
      WORKER_LAMBDA_NAME: workerLambda.name
    }
  },
  callback: async ({ body: rawBody, headers }) => {
    if (!rawBody) {
      return { statusCode: 400, body: 'Bad Request: Missing body' };
    }

    try {
      // 1. Authorize the request from Slack
      authorize({ rawBody, headers: headers as any });
      const body = querystring.parse(Buffer.from(rawBody, 'base64').toString('utf-8'));

      // 2. Asynchronously invoke the worker Lambda
      const lambdaClient = new LambdaClient({});
      const command = new InvokeCommand({
        FunctionName: process.env.WORKER_LAMBDA_NAME,
        InvocationType: 'Event', // This makes the call asynchronous
        Payload: JSON.stringify(body)
      });
      await lambdaClient.send(command);

      // 3. Immediately respond to Slack to avoid timeout
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          response_type: 'ephemeral',
          text: 'On it! 🚀 Triggering the workflow now...'
        })
      };
    } catch (e: any) {
      console.error(e);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          response_type: 'ephemeral',
          text: `Error: ${e.message}`
        })
      };
    }
  }
});

// --- API Gateway to expose the Acknowledger Lambda ---
const endpoint = new awsx.apigateway.API('saga', {
  routes: [
    {
      path: '/', // Changed path to root for simplicity
      method: 'POST',
      eventHandler: acknowledgerLambda
    }
  ]
});

export const url = endpoint.url;