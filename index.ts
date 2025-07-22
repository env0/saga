import * as aws from '@pulumi/aws';
import * as awsx from '@pulumi/awsx';
import * as querystring from 'querystring';
import axios from 'axios';
import { Octokit } from '@octokit/rest';
import { pick } from 'lodash';

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

const authorize = ({
                     rawBody,
                     headers: { 'X-Slack-Signature': signature, 'X-Slack-Request-Timestamp': timestamp }
                   }) => {
  const crypto = require('crypto');
  const version = 'v0';
  const basestring = `${version}:${timestamp}:${rawBody}`;
  const hash = crypto.createHmac('sha256', slackSigningSecret).update(basestring).digest('hex');

  if (signature !== `${version}=${hash}`) {
    throw new Error(`Slack signature mismatch`);
  }
};

const endpoint = new awsx.apigateway.API('saga', {
  routes: [
    {
      path: '/',
      method: 'POST',
      eventHandler: new aws.lambda.CallbackFunction('saga', {
        runtime: 'nodejs16.x',
        callback: async (event : any, context) => {
          context.callbackWaitsForEmptyEventLoop = false;

          try {
            authorize({ rawBody: event.body, headers: event.headers as any });

            const parsedBody = querystring.parse(
              Buffer.from(event.body, 'base64').toString('utf-8')
            ) as SlackSlashCommand;

            // Return immediately
            const immediateResponse = {
              statusCode: 200,
              body: '',
            };

            // Async background work
            (async () => {
              try {
                const args = parsedBody.text?.split(' ') ?? [];
                const eventType = args[0];

                await new Octokit({ auth: githubToken }).rest.repos.createDispatchEvent({
                  owner,
                  repo,
                  event_type: `saga-${eventType}`,
                  client_payload: {
                    ...pick(parsedBody, 'command', 'user_name'),
                    args,
                  },
                });

                await axios.post(parsedBody.response_url, {
                  response_type: 'ephemeral',
                  text: 'On it!',
                });
              } catch (err) {
                console.error('Saga dispatch error:', err);
                await axios.post(parsedBody.response_url, {
                  response_type: 'ephemeral',
                  text: '❌ Failed to trigger GitHub Actions. See logs.',
                });
              }
            })().then(r => console.log(r));

            return immediateResponse;
          } catch (err) {
            console.error('Auth or parsing failed:', err);
            return {
              statusCode: 401,
              body: 'Unauthorized',
            };
          }
        }
,
      }),
    },
  ],
});

exports.endpoint = endpoint.url;
