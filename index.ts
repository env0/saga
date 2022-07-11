import * as awsx from '@pulumi/awsx';
import * as querystring from 'querystring';
import * as crypto from 'crypto';
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

type EventType = 'tag' | 'deploy';

const authorize = ({
  rawBody,
  headers: { 'X-Slack-Signature': signature, 'X-Slack-Request-Timestamp': timestamp }
}) => {
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
      eventHandler: async ({ body: rawBody, headers }) => {
        authorize({ rawBody, headers: headers as any });

        const body = querystring.parse(Buffer.from(rawBody, 'base64').toString('utf-8')) as SlackSlashCommand;

        const respondToSlack = async text =>
          axios.post(body.response_url, {
            response_type: 'ephemeral',
            text
          });

        const notifyProdChannel = async (eventType: EventType) => {
          const prodChannelId = 'CR4MU5RLN';
          const actions: Record<EventType, string> = {
            tag: 'tagged a new release',
            deploy: 'triggered a deployment'
          }
          return axios.post(body.response_url, {
            response_type: 'ephemeral',
            channel: prodChannelId,
            text: `${body.user_name} ${actions[eventType]}`
          });
        }

        try {
          const args = body.text?.split(' ');
          const eventType = args[0] as EventType;

          await new Octokit({ auth: githubToken }).rest.repos.createDispatchEvent({
            repo,
            owner,
            event_type: `saga-${eventType}`,
            client_payload: { ...pick(body, 'command', 'user_name'), args }
          });

          await respondToSlack('On it!');
          await notifyProdChannel(eventType);
        } catch (e) {
          console.error(e);
          await respondToSlack('Failed to trigger GitHub Actions - see saga cloudwatch logs for details');
        }

        return { statusCode: 200, body: '' };
      }
    }
  ]
});

exports.endpoint = endpoint.url;
