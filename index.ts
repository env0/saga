import * as aws from '@pulumi/aws';
import * as awsx from '@pulumi/awsx';
import * as querystring from 'querystring';
import axios from 'axios';
import { Octokit } from '@octokit/rest';
import { pick } from 'lodash';

// Environment variables should be configured in your Pulumi stack or Lambda environment
const owner = process.env.GITHUB_OWNER;
const repo = process.env.GITHUB_REPO;
const githubToken = process.env.GITHUB_TOKEN;
const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;

// Type definition for the Slack slash command payload
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

/**
 * Verifies that the incoming request is a genuine request from Slack.
 * @param {object} params - The parameters for authorization.
 * @param {string} params.rawBody - The raw request body from API Gateway.
 * @param {object} params.headers - The request headers.
 */
const authorize = ({
                     rawBody,
                     headers: { 'X-Slack-Signature': signature, 'X-Slack-Request-Timestamp': timestamp }
                   }) => {
  // Ensure required secrets and headers are present
  if (!slackSigningSecret || !signature || !timestamp) {
    throw new Error('Missing Slack signing secret or request headers for verification.');
  }

  // Prevent replay attacks by checking if the timestamp is recent (e.g., within 5 minutes)
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp as string, 10) < fiveMinutesAgo) {
    throw new Error('Slack request timestamp is too old.');
  }

  const crypto = require('crypto');
  const version = 'v0';
  const basestring = `${version}:${timestamp}:${rawBody}`;
  const hash = crypto.createHmac('sha256', slackSigningSecret).update(basestring).digest('hex');

  // Compare the generated hash with the signature from the request
  if (`${version}=${hash}` !== signature) {
    throw new Error('Slack signature verification failed.');
  }
};

const endpoint = new awsx.apigateway.API('saga', {
  routes: [
    {
      path: '',
      method: 'POST',
      eventHandler: new aws.lambda.CallbackFunction('saga', {
        runtime: 'nodejs16.x',
        callback: async ({ body: rawBody, headers }) => {
          try {
            // First, authorize the request. Throws an error on failure.
            authorize({ rawBody, headers: headers as any });
          } catch (error: any) {
            console.error('Authorization failed:', error.message);
            // Return an error status if authorization fails
            return { statusCode: 401, body: 'Authorization failed.' };
          }

          const body = querystring.parse(Buffer.from(rawBody, 'base64').toString('utf-8')) as SlackSlashCommand;

          /**
           * This function contains the long-running logic.
           * It's called without 'await' to allow the main function to return immediately.
           */
          const runBackgroundTask = async () => {
            // Helper to send follow-up messages to the response_url
            const respondToSlack = (text: string) =>
              axios.post(body.response_url, {
                response_type: 'ephemeral', // 'ephemeral' is visible only to the user, 'in_channel' is visible to everyone
                text,
              });

            try {
              const args = body.text?.split(' ') || [];
              const eventType = args[0];

              if (!eventType) {
                await respondToSlack('Error: Please provide a command. For example: `/your-command deploy`');
                return;
              }

              // Trigger the GitHub repository_dispatch event
              await new Octokit({ auth: githubToken }).rest.repos.createDispatchEvent({
                repo: repo!,
                owner: owner!,
                event_type: `saga-${eventType}`,
                client_payload: { ...pick(body, 'command', 'user_name'), args },
              });

              // On success, send a confirmation message back to Slack
              await respondToSlack(`✅ Successfully triggered GitHub Action for \`${eventType}\`!`);
            } catch (e: any) {
              console.error(e);
              // On failure, send an error message back to Slack
              await respondToSlack('❌ Failed to trigger GitHub Actions. Please check the logs for details.');
            }
          };

          // Fire-and-forget the background task. The Lambda runtime will keep the process
          // alive until this promise resolves or the function times out.
          runBackgroundTask();

          // Immediately return a 200 OK with an initial acknowledgment message.
          // This satisfies Slack's 3-second timeout.
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              response_type: 'ephemeral',
              text: 'Got it! Triggering the workflow now...',
            }),
          };
        },
      }),
    },
  ],
});

exports.endpoint = endpoint.url;
