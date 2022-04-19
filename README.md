# **S**lack **A**pp to trigger **G**itHub **A**ctions (aka SAGA)
This is a Pulumi Stack that creates an API Gateway endpoint with Lambda that triggers GitHub `dispatch_workflow` GitHub Actions.  
- At least one argument to Slack's slash command is expected
- The first argument will be the event name, prefixed with `saga-`.  
- The rest of the arguments are sent to GitHub Action inside the `client_payload` as `args`
- The output of this stack is an API endpoint that can be used as the receiving end of a [Slack App Slash Command](https://api.slack.com/interactivity/slash-commands)

## Deployment
### Required Environment Variables
- `GITHUB_TOKEN` - the GitHub token used to interact with GitHub Actions
- `GITHUB_OWNER` - GitHub owner of the repository holding the GitHub Action
- `GITHUB_REPO` - GitHub repository holding the GitHub Action
- `SLACK_SIGNING_SECRET` - the signing secret of the triggering Slack App

### Outputs
`endpoint` - the endpoint to be set as the Slack App Slash Command target
