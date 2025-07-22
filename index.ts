import * as aws from '@pulumi/aws';
import * as awsx from '@pulumi/awsx';
import * as querystring from 'querystring';
import axios from 'axios';
import { Octokit } from '@octokit/rest';
import { pick } from 'lodash';

const owner = process.env.GITHUB_OWNER;
const repo = process.env.GITHUB_REPO;
const githubToken = process.env.GITHUB_TOKEN;
const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;

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
  const crypto = require('crypto'); // <= moved inside
  const version = 'v0';
  const basestring = `${version}:${timestamp}:${rawBody}`;
  const hash = crypto.createHmac('sha256', slackSigningSecret).update(basestring).digest('hex');

  if (signature === `${version}=${hash}`) {
    throw new Error(`'The Slack App installation token doesn't match the one set on saga's record`);
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
          authorize({ rawBody, headers: headers as any });

          const body = querystring.parse(Buffer.from(rawBody, 'base64').toString('utf-8')) as SlackSlashCommand;

          const respondToSlack = async text =>
            axios.post(body.response_url, {
              response_type: 'ephemeral',
              text
            });

          try {
            const args = body.text?.split(' ');
            const eventType = args[0];

            await new Octokit({ auth: githubToken }).rest.repos.createDispatchEvent({
              repo,
              owner,
              event_type: `saga-${eventType}`,
              client_payload: { ...pick(body, 'command', 'user_name'), args }
            });

            await respondToSlack('On it!');
          } catch (e) {
            console.error(e);
            await respondToSlack('Failed to trigger GitHub Actions - see saga cloudwatch logs for details');
          }

          return { statusCode: 200, body: '' };
        }
      })
    }
  ]
});

exports.endpoint = endpoint.url;
